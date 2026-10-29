import { type CSSProperties, useEffect, useId, useRef } from 'react'
import type { ImportedColor, MapTreeFeature, MapTreeNode, MapTreeSymbol } from '../lib/api'

type NodeState = 'checked' | 'unchecked' | 'mixed'

type VisibilityTreeProps = {
  nodes: MapTreeNode[]
  checkedMap: Record<string, boolean>
  expandedMap: Record<string, boolean>
  disabled?: boolean
  onToggleChecked: (node: MapTreeNode, nextChecked: boolean) => void
  onToggleFeatureChecked: (feature: MapTreeFeature, nextChecked: boolean) => void
  onToggleExpanded: (nodeId: string) => void
}

function Checkbox({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate
    }
  }, [indeterminate])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  )
}

function nodeState(node: MapTreeNode, checkedMap: Record<string, boolean>): NodeState {
  const selfChecked = checkedMap[node.id] ?? false
  const features = node.features ?? []

  if (node.children.length === 0 && features.length === 0) {
    return selfChecked ? 'checked' : 'unchecked'
  }

  const childStates = [
    ...features.map((feature) =>
      checkedMap[featureTreeKey(feature.id)] ?? false ? 'checked' : 'unchecked',
    ),
    ...node.children.map((child) => nodeState(child, checkedMap)),
  ]
  const allChildrenChecked = childStates.every((state) => state === 'checked')
  const allChildrenUnchecked = childStates.every((state) => state === 'unchecked')

  if (selfChecked && allChildrenChecked) {
    return 'checked'
  }

  if (!selfChecked && allChildrenUnchecked) {
    return 'unchecked'
  }

  return 'mixed'
}

export function featureTreeKey(featureId: string) {
  return `feature:${featureId}`
}

function nodeFeatures(node: MapTreeNode) {
  return node.features ?? []
}

function colorToCss(color: ImportedColor | undefined, fallback: ImportedColor) {
  const value = color ?? fallback
  return `rgba(${value[0]}, ${value[1]}, ${value[2]}, ${(value[3] ?? 255) / 255})`
}

function isRenderableIconHref(value: string | undefined) {
  return Boolean(value && /^(https?:|data:|blob:)/i.test(value))
}

function symbolKind(symbol: MapTreeSymbol) {
  return (symbol.geometryType ?? '').toLowerCase()
}

function symbolLabel(symbol: MapTreeSymbol) {
  const geometryType = symbol.geometryType ?? 'Feature'
  return `${symbol.count} ${geometryType}${symbol.count === 1 ? '' : 's'}`
}

function googleEarthShapeClass(iconHref: string | undefined) {
  const href = iconHref?.toLowerCase() ?? ''

  if (href.includes('shaded_dot') || href.includes('target') || href.includes('bullseye')) {
    return 'tree-symbol--target'
  }

  if (href.includes('placemark_square') || href.includes('square')) {
    return 'tree-symbol--square'
  }

  if (href.includes('triangle')) {
    return 'tree-symbol--triangle'
  }

  return null
}

function FolderSymbol({ symbol }: { symbol: MapTreeSymbol }) {
  const kind = symbolKind(symbol)
  const pointColor = colorToCss(
    symbol.style?.pointColor ?? symbol.style?.labelColor,
    [255, 106, 69, 230],
  )
  const lineColor = colorToCss(symbol.style?.lineColor, [244, 164, 88, 255])
  const fillColor = colorToCss(symbol.style?.fillColor, [53, 145, 112, 52])
  const iconHref = symbol.style?.iconHref
  const shapeClass = googleEarthShapeClass(iconHref)
  const title = symbolLabel(symbol)

  if (kind.includes('point') && shapeClass) {
    return (
      <span
        className={`tree-symbol ${shapeClass}`}
        title={title}
        aria-label={title}
        style={{ '--tree-symbol-point': pointColor } as CSSProperties}
      />
    )
  }

  if (kind.includes('point') && isRenderableIconHref(iconHref)) {
    return (
      <span className="tree-symbol tree-symbol--image" title={title} aria-label={title}>
        <img src={iconHref} alt="" loading="lazy" />
      </span>
    )
  }

  if (kind.includes('line')) {
    return (
      <span
        className="tree-symbol tree-symbol--line"
        title={title}
        aria-label={title}
        style={{ '--tree-symbol-line': lineColor } as CSSProperties}
      />
    )
  }

  if (kind.includes('polygon')) {
    return (
      <span
        className="tree-symbol tree-symbol--polygon"
        title={title}
        aria-label={title}
        style={
          {
            '--tree-symbol-fill': fillColor,
            '--tree-symbol-line': lineColor,
          } as CSSProperties
        }
      />
    )
  }

  return (
    <span
      className="tree-symbol tree-symbol--point"
      title={title}
      aria-label={title}
      style={{ '--tree-symbol-point': pointColor } as CSSProperties}
    />
  )
}

function FeatureSymbol({ feature }: { feature: MapTreeFeature }) {
  return (
    <FolderSymbol
      symbol={{
        count: 1,
        geometryType: feature.geometryType,
        style: feature.style,
        styleUrl: feature.styleUrl,
      }}
    />
  )
}

function TreeFeatureRow({
  feature,
  checkedMap,
  depth,
  disabled,
  onToggleChecked,
}: {
  feature: MapTreeFeature
  checkedMap: Record<string, boolean>
  depth: number
  disabled?: boolean
  onToggleChecked: (feature: MapTreeFeature, nextChecked: boolean) => void
}) {
  const checked = checkedMap[featureTreeKey(feature.id)] ?? false
  const countId = useId()
  const label = feature.displayName?.trim() || feature.name

  return (
    <li className={`tree-node tree-node--feature ${checked ? 'tree-node--checked' : 'tree-node--unchecked'}`}>
      <div
        className={`tree-row tree-row--feature ${disabled ? 'tree-row--disabled' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
      >
        <span className="tree-expander" aria-hidden="true" />

        <Checkbox
          checked={checked}
          indeterminate={false}
          disabled={disabled}
          onChange={(nextChecked) => onToggleChecked(feature, nextChecked)}
        />

        <FeatureSymbol feature={feature} />

        <div className="tree-labels" aria-describedby={countId}>
          <div className="tree-label-line">
            <strong title={feature.name}>{label}</strong>
          </div>
          <span id={countId}>{feature.geometryType ?? 'Feature'}</span>
        </div>
      </div>
    </li>
  )
}

function TreeNodeRow({
  node,
  checkedMap,
  expandedMap,
  disabled,
  onToggleChecked,
  onToggleFeatureChecked,
  onToggleExpanded,
}: {
  node: MapTreeNode
  checkedMap: Record<string, boolean>
  expandedMap: Record<string, boolean>
  disabled?: boolean
  onToggleChecked: (node: MapTreeNode, nextChecked: boolean) => void
  onToggleFeatureChecked: (feature: MapTreeFeature, nextChecked: boolean) => void
  onToggleExpanded: (nodeId: string) => void
}) {
  const state = nodeState(node, checkedMap)
  const expanded = expandedMap[node.id] ?? (node.isOpenByDefault || node.depth === 0)
  const countId = useId()
  const depth = Math.min(Math.max(node.depth, 0), 5)
  const symbols = node.symbols ?? []
  const features = nodeFeatures(node)

  return (
    <li className={`tree-node tree-node--${state}`}>
      <div
        className={`tree-row ${disabled ? 'tree-row--disabled' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
      >
        <button
          type="button"
          className="tree-expander"
          onClick={() => onToggleExpanded(node.id)}
          aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
          disabled={disabled || (node.children.length === 0 && features.length === 0)}
        >
          {node.children.length === 0 && features.length === 0 ? '' : expanded ? '▾' : '▸'}
        </button>

        <Checkbox
          checked={state === 'checked'}
          indeterminate={state === 'mixed'}
          disabled={disabled}
          onChange={(nextChecked) => onToggleChecked(node, nextChecked)}
        />

        <span
          className={`tree-folder-icon ${expanded ? 'tree-folder-icon--open' : ''}`}
          aria-hidden="true"
        />

        <div className="tree-labels" aria-describedby={countId}>
          <div className="tree-label-line">
            <strong title={node.name}>{node.name}</strong>
            {symbols.length > 0 ? (
              <span className="tree-symbols" aria-label="Folder legend symbols">
                {symbols.map((symbol) => (
                  <FolderSymbol
                    key={`${symbol.geometryType ?? 'unknown'}-${symbol.styleUrl ?? 'unstyled'}`}
                    symbol={symbol}
                  />
                ))}
              </span>
            ) : null}
            {node.counts.childFolders > 0 ? (
              <span className="tree-count" aria-label={`${node.counts.childFolders} child folders`}>
                {node.counts.childFolders}
              </span>
            ) : null}
          </div>
          <span id={countId}>
            {node.counts.directFeatures} direct · {node.counts.descendantFeatures} visible
          </span>
        </div>
      </div>

      {expanded && (features.length > 0 || node.children.length > 0) ? (
        <ul className="tree-children">
          {features.map((feature) => (
            <TreeFeatureRow
              key={feature.id}
              feature={feature}
              checkedMap={checkedMap}
              depth={depth + 1}
              disabled={disabled}
              onToggleChecked={onToggleFeatureChecked}
            />
          ))}
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              checkedMap={checkedMap}
              expandedMap={expandedMap}
              disabled={disabled}
              onToggleChecked={onToggleChecked}
              onToggleFeatureChecked={onToggleFeatureChecked}
              onToggleExpanded={onToggleExpanded}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function VisibilityTree({
  nodes,
  checkedMap,
  expandedMap,
  disabled,
  onToggleChecked,
  onToggleFeatureChecked,
  onToggleExpanded,
}: VisibilityTreeProps) {
  if (nodes.length === 0) {
    return <p className="tree-empty">No imported folders yet.</p>
  }

  return (
    <ul className="tree-root">
      {nodes.map((node) => (
        <TreeNodeRow
          key={node.id}
          node={node}
          checkedMap={checkedMap}
          expandedMap={expandedMap}
          disabled={disabled}
          onToggleChecked={onToggleChecked}
          onToggleFeatureChecked={onToggleFeatureChecked}
          onToggleExpanded={onToggleExpanded}
        />
      ))}
    </ul>
  )
}

export function collectNodeIds(node: MapTreeNode): string[] {
  return [node.id, ...node.children.flatMap(collectNodeIds)]
}

export function collectTreeCheckIds(node: MapTreeNode): string[] {
  return [
    node.id,
    ...nodeFeatures(node).map((feature) => featureTreeKey(feature.id)),
    ...node.children.flatMap(collectTreeCheckIds),
  ]
}

export function collectRenderableFolderIds(
  nodes: MapTreeNode[],
  checkedMap: Record<string, boolean>,
): string[] {
  const selected = new Set<string>()

  const walk = (node: MapTreeNode) => {
    const hasVisibleDirectFeature = nodeFeatures(node).some(
      (feature) => checkedMap[featureTreeKey(feature.id)] ?? false,
    )

    if ((checkedMap[node.id] ?? false) || hasVisibleDirectFeature) {
      selected.add(node.id)
    }

    for (const child of node.children) {
      walk(child)
    }
  }

  for (const node of nodes) {
    walk(node)
  }

  return [...selected]
}

export function collectHiddenFolderIds(
  nodes: MapTreeNode[],
  checkedMap: Record<string, boolean>,
): string[] {
  if (Object.keys(checkedMap).length === 0) {
    return []
  }

  const hidden = new Set<string>()

  const walk = (
    node: MapTreeNode,
  ): { hasVisibleContent: boolean; hiddenFolderIds: string[] } => {
    const hasVisibleDirectFeature = nodeFeatures(node).some(
      (feature) => checkedMap[featureTreeKey(feature.id)] ?? false,
    )
    const childResults = node.children.map(walk)
    const hasVisibleContent =
      (checkedMap[node.id] ?? false) ||
      hasVisibleDirectFeature ||
      childResults.some((result) => result.hasVisibleContent)

    if (!hasVisibleContent) {
      return {
        hasVisibleContent: false,
        hiddenFolderIds: [node.id],
      }
    }

    return {
      hasVisibleContent: true,
      hiddenFolderIds: childResults.flatMap((result) => result.hiddenFolderIds),
    }
  }

  for (const node of nodes) {
    for (const folderId of walk(node).hiddenFolderIds) {
      hidden.add(folderId)
    }
  }

  return [...hidden]
}

export function collectHiddenFeatureIds(
  nodes: MapTreeNode[],
  checkedMap: Record<string, boolean>,
  visibleFolderIds?: string[],
): string[] {
  if (Object.keys(checkedMap).length === 0) {
    return []
  }

  const hidden = new Set<string>()
  const visibleFolderIdSet =
    visibleFolderIds === undefined ? null : new Set(visibleFolderIds)

  const walk = (node: MapTreeNode) => {
    const folderIsVisible =
      visibleFolderIdSet === null || visibleFolderIdSet.has(node.id)

    if (folderIsVisible) {
      for (const feature of nodeFeatures(node)) {
        if (!(checkedMap[featureTreeKey(feature.id)] ?? false)) {
          hidden.add(feature.id)
        }
      }
    }

    for (const child of node.children) {
      walk(child)
    }
  }

  for (const node of nodes) {
    walk(node)
  }

  return [...hidden]
}
