import { Injectable, Logger } from '@nestjs/common';
import { access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import sax from 'sax';
import unzipper from 'unzipper';
import type { MapRecord } from '../database/schemas';

type RgbaColor = [number, number, number, number];

type ParsedStyle = {
  pointColor?: RgbaColor;
  lineColor?: RgbaColor;
  fillColor?: RgbaColor;
  labelColor?: RgbaColor;
  lineWidth?: number;
  iconScale?: number;
  iconHref?: string;
  labelScale?: number;
  polyFill?: boolean;
  polyOutline?: boolean;
};

type ParsedStyleMap = {
  normal?: string;
  highlight?: string;
};

type StyleIndex = {
  styles: Map<string, ParsedStyle>;
  styleMaps: Map<string, ParsedStyleMap>;
};

export type ResolvedFeatureStyle = {
  pointColor?: RgbaColor;
  lineColor?: RgbaColor;
  fillColor?: RgbaColor;
  labelColor?: RgbaColor;
  lineWidth?: number;
  iconScale?: number;
  iconHref?: string;
  labelScale?: number;
};

function normalizeTagName(name: string) {
  const colonIndex = name.indexOf(':');
  return (colonIndex >= 0 ? name.slice(colonIndex + 1) : name).toLowerCase();
}

function normalizeStyleRef(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^#/, '');
}

function toFiniteNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseKmlColor(value: string): RgbaColor | undefined {
  const normalized = value.trim().replace(/[^a-fA-F0-9]/g, '');
  if (normalized.length !== 8) {
    return undefined;
  }

  const alpha = Number.parseInt(normalized.slice(0, 2), 16);
  const blue = Number.parseInt(normalized.slice(2, 4), 16);
  const green = Number.parseInt(normalized.slice(4, 6), 16);
  const red = Number.parseInt(normalized.slice(6, 8), 16);

  if ([alpha, blue, green, red].some((item) => Number.isNaN(item))) {
    return undefined;
  }

  return [red, green, blue, alpha];
}

function inferPointColorFromIconHref(iconHref?: string): RgbaColor | undefined {
  if (!iconHref) {
    return undefined;
  }

  const href = iconHref.toLowerCase();

  if (href.includes('ltblu')) {
    return [102, 204, 255, 255];
  }

  if (href.includes('ylw')) {
    return [255, 214, 0, 255];
  }

  if (href.includes('red')) {
    return [255, 82, 82, 255];
  }

  if (href.includes('green') || href.includes('grn')) {
    return [76, 175, 80, 255];
  }

  if (href.includes('blue') || href.includes('blu')) {
    return [66, 133, 244, 255];
  }

  if (href.includes('purple')) {
    return [156, 39, 176, 255];
  }

  if (href.includes('pink')) {
    return [236, 64, 122, 255];
  }

  if (href.includes('orange')) {
    return [255, 152, 0, 255];
  }

  if (href.includes('wht') || href.includes('white')) {
    return [255, 255, 255, 255];
  }

  return undefined;
}

function transparentVariant(color?: RgbaColor): RgbaColor {
  if (!color) {
    return [0, 0, 0, 0];
  }

  return [color[0], color[1], color[2], 0];
}

function cloneColor(color?: RgbaColor): RgbaColor | undefined {
  if (!color) {
    return undefined;
  }

  return [color[0], color[1], color[2], color[3]];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class MapStyleResolverService {
  private readonly logger = new Logger(MapStyleResolverService.name);
  private readonly cache = new Map<string, Promise<StyleIndex>>();

  async getStyleIndex(
    mapRecord: Pick<MapRecord, 'id' | 'updatedAt' | 'sourceDocumentPath'>,
  ) {
    const updatedAt =
      mapRecord.updatedAt instanceof Date
        ? mapRecord.updatedAt.toISOString()
        : String(mapRecord.updatedAt);
    const cacheKey = `${mapRecord.id}:${updatedAt}:${mapRecord.sourceDocumentPath ?? ''}:full-style-scan-v2`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = this.buildStyleIndex(mapRecord.sourceDocumentPath);
    this.cache.set(cacheKey, pending);

    try {
      return await pending;
    } catch (error) {
      this.cache.delete(cacheKey);
      throw error;
    }
  }

  async resolveFeatureStyle(
    mapRecord: Pick<MapRecord, 'id' | 'updatedAt' | 'sourceDocumentPath'>,
    styleUrl?: string | null,
  ): Promise<ResolvedFeatureStyle | null> {
    const styleId = normalizeStyleRef(styleUrl);
    if (!styleId || !mapRecord.sourceDocumentPath) {
      return null;
    }

    const index = await this.getStyleIndex(mapRecord);
    return this.resolveStyle(index, styleId);
  }

  private resolveStyle(
    index: StyleIndex,
    styleId: string,
  ): ResolvedFeatureStyle | null {
    const visited = new Set<string>();
    let resolvedId = styleId;

    while (!visited.has(resolvedId)) {
      visited.add(resolvedId);

      const styleMap = index.styleMaps.get(resolvedId);
      if (!styleMap) {
        break;
      }

      const nextId = normalizeStyleRef(styleMap.normal ?? styleMap.highlight);
      if (!nextId) {
        break;
      }

      resolvedId = nextId;
    }

    const parsedStyle = index.styles.get(resolvedId);
    if (!parsedStyle) {
      return null;
    }

    let fillColor = cloneColor(parsedStyle.fillColor);
    let lineColor = cloneColor(parsedStyle.lineColor);

    if (parsedStyle.polyFill === false) {
      fillColor = transparentVariant(fillColor);
    }

    if (parsedStyle.polyOutline === false) {
      lineColor = transparentVariant(lineColor);
    }

    const pointColor = cloneColor(
      parsedStyle.pointColor ??
        inferPointColorFromIconHref(parsedStyle.iconHref),
    );

    return {
      pointColor,
      lineColor,
      fillColor,
      labelColor: cloneColor(parsedStyle.labelColor ?? pointColor),
      lineWidth: parsedStyle.lineWidth,
      iconScale: parsedStyle.iconScale,
      iconHref: parsedStyle.iconHref,
      labelScale: parsedStyle.labelScale,
    };
  }

  private async buildStyleIndex(
    sourceDocumentPath?: string | null,
  ): Promise<StyleIndex> {
    if (!sourceDocumentPath) {
      return {
        styles: new Map(),
        styleMaps: new Map(),
      };
    }

    const stream = await this.openSourceStream(sourceDocumentPath);
    stream.setEncoding('utf8');

    const index: StyleIndex = {
      styles: new Map(),
      styleMaps: new Map(),
    };

    let currentStyleId: string | null = null;
    let currentStyle: ParsedStyle | null = null;
    let currentStyleSection: 'icon' | 'line' | 'poly' | 'label' | null = null;
    let currentStyleMapId: string | null = null;
    let currentStyleMap: ParsedStyleMap | null = null;
    let currentPairKey: string | null = null;
    let captureTag:
      | 'color'
      | 'width'
      | 'scale'
      | 'styleurl'
      | 'key'
      | 'fill'
      | 'outline'
      | 'href'
      | null = null;
    let captureText = '';
    const parser = sax.parser(true, {
      trim: false,
      normalize: false,
      lowercase: false,
      xmlns: false,
    });

    parser.onopentag = (tag) => {
      const tagName = normalizeTagName(tag.name);

      if (tagName === 'style' && typeof tag.attributes.id === 'string') {
        currentStyleId = tag.attributes.id;
        currentStyle = {};
      } else if (
        tagName === 'stylemap' &&
        typeof tag.attributes.id === 'string'
      ) {
        currentStyleMapId = tag.attributes.id;
        currentStyleMap = {};
      } else if (tagName === 'iconstyle') {
        currentStyleSection = 'icon';
      } else if (tagName === 'linestyle') {
        currentStyleSection = 'line';
      } else if (tagName === 'polystyle') {
        currentStyleSection = 'poly';
      } else if (tagName === 'labelstyle') {
        currentStyleSection = 'label';
      } else if (tagName === 'pair') {
        currentPairKey = null;
      }

      if (
        tagName === 'color' ||
        tagName === 'width' ||
        tagName === 'scale' ||
        tagName === 'styleurl' ||
        tagName === 'key' ||
        tagName === 'fill' ||
        tagName === 'outline' ||
        tagName === 'href'
      ) {
        captureTag = tagName;
        captureText = '';
      }
    };

    parser.ontext = (text) => {
      if (captureTag) {
        captureText += text;
      }
    };

    parser.oncdata = (text) => {
      if (captureTag) {
        captureText += text;
      }
    };

    parser.onclosetag = (name) => {
      const tagName = normalizeTagName(name);

      if (captureTag === tagName) {
        const value = captureText.trim();

        if (currentStyle) {
          if (tagName === 'color') {
            const color = parseKmlColor(value);
            if (color) {
              if (currentStyleSection === 'icon') {
                currentStyle.pointColor = color;
              } else if (currentStyleSection === 'line') {
                currentStyle.lineColor = color;
              } else if (currentStyleSection === 'poly') {
                currentStyle.fillColor = color;
              } else if (currentStyleSection === 'label') {
                currentStyle.labelColor = color;
              }
            }
          } else if (tagName === 'width' && currentStyleSection === 'line') {
            currentStyle.lineWidth = toFiniteNumber(value);
          } else if (tagName === 'scale') {
            const scale = toFiniteNumber(value);
            if (currentStyleSection === 'icon') {
              currentStyle.iconScale = scale;
            } else if (currentStyleSection === 'label') {
              currentStyle.labelScale = scale;
            }
          } else if (tagName === 'href' && currentStyleSection === 'icon') {
            currentStyle.iconHref = value || undefined;
          } else if (tagName === 'fill' && currentStyleSection === 'poly') {
            currentStyle.polyFill = value !== '0';
          } else if (tagName === 'outline' && currentStyleSection === 'poly') {
            currentStyle.polyOutline = value !== '0';
          }
        }

        if (currentStyleMap) {
          if (tagName === 'key') {
            currentPairKey = value || null;
          } else if (tagName === 'styleurl') {
            const styleRef = normalizeStyleRef(value);
            if (styleRef && currentPairKey) {
              if (currentPairKey === 'normal') {
                currentStyleMap.normal = styleRef;
              } else if (currentPairKey === 'highlight') {
                currentStyleMap.highlight = styleRef;
              }
            }
          }
        }

        captureTag = null;
        captureText = '';
      }

      if (
        tagName === 'iconstyle' ||
        tagName === 'linestyle' ||
        tagName === 'polystyle' ||
        tagName === 'labelstyle'
      ) {
        currentStyleSection = null;
      } else if (tagName === 'style') {
        if (currentStyleId && currentStyle) {
          index.styles.set(currentStyleId, currentStyle);
        }

        currentStyleId = null;
        currentStyle = null;
      } else if (tagName === 'stylemap') {
        if (currentStyleMapId && currentStyleMap) {
          index.styleMaps.set(currentStyleMapId, currentStyleMap);
        }

        currentStyleMapId = null;
        currentStyleMap = null;
      } else if (tagName === 'pair') {
        currentPairKey = null;
      }
    };

    try {
      for await (const chunk of stream as AsyncIterable<string>) {
        parser.write(chunk);
      }

      parser.close();
    } catch (error) {
      this.logger.warn(
        `Failed to parse style index from ${sourceDocumentPath}: ${
          error instanceof Error ? error.message : 'Unknown style parsing error'
        }`,
      );
      throw error;
    } finally {
      stream.destroy();
    }

    return index;
  }

  private async openSourceStream(
    sourceDocumentPath: string,
  ): Promise<Readable> {
    const archiveSeparator = '::';
    if (sourceDocumentPath.includes(archiveSeparator)) {
      const [archivePath, archiveEntry] =
        sourceDocumentPath.split(archiveSeparator);
      await access(archivePath);

      return createReadStream(archivePath).pipe(
        unzipper.ParseOne(new RegExp(`${escapeRegExp(archiveEntry)}$`, 'i')),
      ) as Readable;
    }

    await access(sourceDocumentPath);
    return createReadStream(sourceDocumentPath);
  }
}
