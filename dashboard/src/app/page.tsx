"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import JSZip from 'jszip';
import { Navbar } from "../components/Navbar";
import { CheckCircle, AlertCircle, Info, X } from "lucide-react";
import GenerationProgressModal from "@/components/GenerationProgressModal";
import GenerationConfigModal, { GenerationConfig, DEFAULT_CONFIG } from "@/components/GenerationConfigModal";
import ValidationStatsPanel, { DesignStats, ValidationResult } from "@/components/ValidationStatsPanel";
import VersionHistoryPanel, { DesignVersion } from "@/components/VersionHistoryPanel";

import { Sidebar, FeatureFilters } from "../components/Sidebar";
import { useSession } from "@/lib/auth-client";
import { DEFAULT_FEATURE_COLORS, resolveFeatureColors } from "@/lib/feature-colors";

// Dynamically import the MapComponent so it only renders on the client
// Leaflet requires window, which is undefined on the server
const MapComponent = dynamic(() => import('../components/Map'), { 
  ssr: false,
  loading: () => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', backgroundColor: '#f3f4f6' }}>Memuat peta...</div>
}) as React.ComponentType<{ 
  layers: LayerConfig[], 
  onShowMessage?: (msg: string, type: 'success'|'error'|'info') => void, 
  filters: FeatureFilters,
  kmlTrees?: Record<string, KmlNode[]>,
  onTreeLoaded?: (layerId: string, tree: KmlNode[]) => void,
  isSidebarCollapsed?: boolean,
  featureColors?: Record<string, string>
}>;

let toastIdCounter = 0;

export type LayerConfig = {
  id: string;
  name: string;
  url: string;
  visible: boolean;
  color?: string;
  groupId?: string;
  groupName?: string;
  designName?: string;
  boundaryName?: string;
  status?: string;
};

export type KmlNode = {
  id: string;
  name: string;
  type: 'folder' | 'placemark';
  geomType?: 'Point' | 'LineString' | 'Polygon';
  visible: boolean;
  children?: KmlNode[];
};

const initialLayers: LayerConfig[] = [];
const defaultFeatureFilters: FeatureFilters = {
  showPop: true,
  showOdc: true,
  showOdp: true,
  showHouse: false,
  showFeeder: true,
  showDistribution: true,
};

const boundaryGroupKey = (name: string) => {
  const stem = name.replace(/\.[^.]+$/, '').toLowerCase()
    .replace(/(boundary|polygon|pop|olt|sentral)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `boundary:${stem || 'design'}`;
};

export default function Home() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  
  useEffect(() => {
    if (!isPending && !session) {
      router.push('/login');
    }
  }, [session, isPending, router]);

  const canEditColors = (session?.user as { role?: string } | undefined)?.role === "admin";
  const [layers, setLayers] = useState<LayerConfig[]>(initialLayers);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<{stage: string, message: string, percent: number} | null>(null);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [generationConfig, setGenerationConfig] = useState<GenerationConfig>(DEFAULT_CONFIG);
  const [designStats, setDesignStats] = useState<DesignStats | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isRegeneratingCables, setIsRegeneratingCables] = useState(false);
  const [isGeneratingHomepass, setIsGeneratingHomepass] = useState(false);
  const [hasNetworkCore, setHasNetworkCore] = useState(false);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [kmzUrl, setKmzUrl] = useState<string | null>(null);
  const [csvUrl, setCsvUrl] = useState<string | null>(null);
  const [showDownloadPopup, setShowDownloadPopup] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [compareVersions, setCompareVersions] = useState<[DesignVersion, DesignVersion] | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [toasts, setToasts] = useState<{id: number, message: string, type: 'success' | 'error' | 'info'}[]>([]);
  const [filters, setFilters] = useState<FeatureFilters>(() => ({
    ...defaultFeatureFilters,
  }));

  const [featureColors, setFeatureColors] = useState<Record<string, string>>(() => ({
    ...DEFAULT_FEATURE_COLORS,
  }));

  // Project State
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>("");
  const [savedProjects, setSavedProjects] = useState<{ id: string, name: string, updated_at: string, created_at: string }[]>([]);
  const [kmlTrees, setKmlTrees] = useState<Record<string, KmlNode[]>>({});
  // React state updates are asynchronous. Keep the active project identity in
  // refs as well so a burst of imports cannot create several projects before
  // the first POST response has updated state.
  const currentProjectIdRef = useRef<string | null>(null);
  const projectNameRef = useRef("");
  const projectSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const projectContextRef = useRef(0);

  const handleTreeLoaded = useCallback((layerId: string, tree: KmlNode[]) => {
    setKmlTrees(prev => ({ ...prev, [layerId]: tree }));
  }, []);

  const toggleTreeNode = (layerId: string, nodeId: string) => {
    setKmlTrees(prev => {
      const layerTree = prev[layerId];
      if (!layerTree) return prev;

      // Recursive function to toggle a node and all its children
      const toggleNodeAndChildren = (node: KmlNode, targetId: string, forceState?: boolean): KmlNode => {
        if (node.id === targetId || forceState !== undefined) {
          const newState = forceState !== undefined ? forceState : !node.visible;
          return {
            ...node,
            visible: newState,
            children: node.children?.map(child => toggleNodeAndChildren(child, targetId, newState))
          };
        }
        if (node.children) {
          return {
            ...node,
            children: node.children.map(child => toggleNodeAndChildren(child, targetId))
          };
        }
        return node;
      };

      return {
        ...prev,
        [layerId]: layerTree.map(node => toggleNodeAndChildren(node, nodeId))
      };
    });
  };

  const handleToggleFilter = (key: keyof FeatureFilters) => {
    setFilters(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = ++toastIdCounter;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const rememberJob = (jobId: string) => {
    if (typeof window === "undefined") return;
    const jobs = JSON.parse(window.localStorage.getItem("ftth_active_jobs") || "[]") as string[];
    if (!jobs.includes(jobId)) window.localStorage.setItem("ftth_active_jobs", JSON.stringify([...jobs, jobId]));
  };

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      if (typeof window === "undefined") return;
      const jobs = JSON.parse(window.localStorage.getItem("ftth_active_jobs") || "[]") as string[];
      const activeJobs: string[] = [];
      for (const jobId of jobs) {
        try {
          const response = await fetch(`/api/proxy/generate/status/${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (!response.ok) {
            // Expired Redis jobs are no longer resumable.
            continue;
          }
          const payload = await response.json();
          const state = payload.data;
          if (state?.done) continue;
          activeJobs.push(jobId);
          if (!cancelled && state) {
            setIsGenerating(true);
            setGenerationProgress({ stage: state.stage, message: state.message, percent: state.percent || 0 });
          }
        } catch { /* A refresh must not prevent the map from loading. */ }
      }
      if (!cancelled) window.localStorage.setItem("ftth_active_jobs", JSON.stringify(activeJobs));
    };
    void restore();
    const timer = window.setInterval(() => { void restore(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const toggleLayer = (id: string) => {
    setLayers(prev => {
      const target = prev.find(layer => layer.id === id);
      if (!target) return prev;
      const isBoundary = (layer: LayerConfig) =>
        layer.name.toLowerCase().includes('boundary') || layer.id === 'boundary';
      const hasOtherVisibleBoundary = isBoundary(target) && prev.some(layer =>
        layer.id !== id && isBoundary(layer) && layer.visible
      );
      // When several boundaries are visible (for example from an older
      // saved project), clicking one selects it instead of accidentally
      // turning the clicked boundary off.
      const nextVisible = hasOtherVisibleBoundary ? true : !target.visible;
      return prev.map(layer => {
        if (layer.id === id) return { ...layer, visible: nextVisible };
        // A generation must never silently use another visible boundary.
        // Turning one boundary on makes it the active boundary.
        if (nextVisible && isBoundary(target) && isBoundary(layer)) {
          return { ...layer, visible: false };
        }
        return layer;
      });
    });
  };

  const handleLayerColorChange = (id: string, color: string) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, color } : l));
  };

  // Token extraction logic removed because the Next.js proxy route handles it server-side
  // via the HttpOnly cookie.

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/proxy/api/projects');
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      setSavedProjects(data.data || data);
    } catch {
      // Ignore initial fetch errors if not logged in
    }
  }, []);

  useEffect(() => {
    // Wrap to prevent synchronous setState warning from linter
    const load = async () => {
      await fetchProjects();
    };
    load();
  }, [fetchProjects]);

  const saveProject = async (
    name: string,
    overrideLayers?: LayerConfig[],
    overrideFilters?: FeatureFilters,
  ) => {
    // Serialize writes. The first save may be a POST; every queued save then
    // observes the newly returned id and becomes a PUT to that same project.
    const contextAtRequest = projectContextRef.current;
    projectSaveQueueRef.current = projectSaveQueueRef.current.then(async () => {
      try {
        // If the user explicitly opened/created another project while a save
        // was waiting, never apply the old payload to the new project.
        if (contextAtRequest !== projectContextRef.current) return;
        const payload = {
          name,
          layers: overrideLayers || layers,
          filters: overrideFilters || filters,
          feature_colors: featureColors
        };

        const activeProjectId = currentProjectIdRef.current;
        const url = activeProjectId
          ? `/api/proxy/api/projects/${activeProjectId}`
          : '/api/proxy/api/projects';
        const method = activeProjectId ? 'PUT' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('Failed to save project');

        const data = await res.json();
        const project = data.data || data;
        currentProjectIdRef.current = project.id;
        projectNameRef.current = project.name;
        setCurrentProjectId(project.id);
        setProjectName(project.name);
        addToast('Proyek berhasil disimpan!', 'success');
        await fetchProjects();
      } catch {
        addToast(`Gagal menyimpan proyek: Pastikan Anda sudah login`, 'error');
      }
    });
    return projectSaveQueueRef.current;
  };

  const loadProject = async (id: string) => {
    try {
      const res = await fetch(`/api/proxy/api/projects/${id}`);
      if (!res.ok) throw new Error('Failed to load project');
      
      const resp = await res.json();
      const data = resp.data || resp;
      projectContextRef.current += 1;
      currentProjectIdRef.current = data.id;
      projectNameRef.current = data.name;
      setCurrentProjectId(data.id);
      setProjectName(data.name);
      
      const parseJson = <T,>(val: unknown, fallback: T): T => {
        if (typeof val === 'string') {
          try { return JSON.parse(val) as T; } catch { return fallback; }
        }
        return (val as T) || fallback;
      };

      const rawLayers = parseJson(data.layers, []);
      const uniqueLayers = rawLayers.map((l: LayerConfig, index: number) => {
        if (rawLayers.findIndex((x: LayerConfig) => x.id === l.id) !== index) {
          return { ...l, id: `${l.id}-${Date.now()}-${index}` };
        }
        return l;
      });

      // Migrate legacy projects where the old single `design` layer had no
      // parent folder. A visible boundary is the safest owner for that old
      // result; new generations already carry explicit group metadata.
      const boundaryLayers = uniqueLayers.filter((layer: LayerConfig) =>
        layer.name.toLowerCase().includes('boundary') || layer.id === 'boundary'
      );
      const activeBoundary = boundaryLayers.find((layer: LayerConfig) => layer.visible) || boundaryLayers[boundaryLayers.length - 1];
      const normalizedLayers = uniqueLayers.map((layer: LayerConfig) => {
        const isBoundary = layer.name.toLowerCase().includes('boundary') || layer.id === 'boundary';
        if (isBoundary && !layer.groupId) {
          return {
            ...layer,
            groupId: `boundary:${layer.id}`,
            groupName: layer.name,
            boundaryName: layer.name,
          };
        }
        if (layer.id === 'design' && activeBoundary) {
          return {
            ...layer,
            name: layer.name === 'FTTH Design' ? `FTTH Design - ${activeBoundary.name}` : layer.name,
            groupId: activeBoundary.groupId || `boundary:${activeBoundary.id}`,
            groupName: activeBoundary.groupName || activeBoundary.name,
            boundaryName: activeBoundary.name,
            designName: activeBoundary.name,
          };
        }
        if (layer.id.startsWith('design:') && layer.boundaryName) {
          return {
            ...layer,
            groupId: boundaryGroupKey(layer.boundaryName),
            groupName: layer.boundaryName,
          };
        }
        return layer;
      });

      setLayers(normalizedLayers);
      // Project yang sudah memiliki layer FTTH Design dianggap memiliki
      // kandidat Network Core. Endpoint Homepass tetap memvalidasi cache
      // versi terbaru sebelum job benar-benar dijalankan.
      setHasNetworkCore(normalizedLayers.some((layer: LayerConfig) => layer.id === 'design' || layer.id.startsWith('design:')));
      const loadedFilters = parseJson(data.filters, defaultFeatureFilters);
      setFilters({ ...defaultFeatureFilters, ...loadedFilters });
      const savedFeatureColors = parseJson(data.feature_colors, {});
      setFeatureColors(resolveFeatureColors(savedFeatureColors, canEditColors));
      addToast('Proyek berhasil dimuat!', 'success');
    } catch {
      addToast(`Gagal memuat proyek: Akses ditolak`, 'error');
    }
  };

  const unloadProject = () => {
    projectContextRef.current += 1;
    currentProjectIdRef.current = null;
    projectNameRef.current = "";
    setCurrentProjectId(null);
    setProjectName("");
    setLayers([]);
    setHasNetworkCore(false);
    setKmzUrl(null);
    setCsvUrl(null);
    setFilters({ ...defaultFeatureFilters });
    setFeatureColors({ ...DEFAULT_FEATURE_COLORS });
    setKmlTrees({});
    addToast('Proyek ditutup', 'info');
  };

  const deleteProject = async (id: string) => {
    try {
      const res = await fetch(`/api/proxy/api/projects/${id}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to delete project');
      addToast('Proyek berhasil dihapus!', 'success');
      if (currentProjectId === id) {
        projectContextRef.current += 1;
        currentProjectIdRef.current = null;
        projectNameRef.current = "";
        setCurrentProjectId(null);
        setProjectName("");
      }
      fetchProjects();
    } catch {
      addToast(`Gagal menghapus proyek`, 'error');
    }
  };

  const combineKmlFiles = async (files: File[]): Promise<File> => {
    const parser = new DOMParser();
    const serializer = new XMLSerializer();
    
    const combinedDoc = document.implementation.createDocument(null, "kml");
    const kmlEl = combinedDoc.documentElement;
    kmlEl.setAttribute("xmlns", "http://www.opengis.net/kml/2.2");
    const documentEl = combinedDoc.createElement("Document");
    kmlEl.appendChild(documentEl);

    for (const file of files) {
      const text = await file.text();
      const doc = parser.parseFromString(text, "text/xml");
      
      const docs = doc.getElementsByTagName("Document");
      if (docs.length > 0) {
        for (let i = 0; i < docs.length; i++) {
           const children = Array.from(docs[i].children);
           for (const child of children) {
             documentEl.appendChild(combinedDoc.importNode(child, true));
           }
        }
      } else {
        const kmlNode = doc.getElementsByTagName("kml")[0];
        if (kmlNode) {
          const children = Array.from(kmlNode.children);
          for (const child of children) {
            documentEl.appendChild(combinedDoc.importNode(child, true));
          }
        }
      }
    }

    const combinedXml = serializer.serializeToString(combinedDoc);
    const blob = new Blob([combinedXml], { type: "application/vnd.google-earth.kml+xml" });
    
    // Format date DD-MM-YYYY
    const date = new Date();
    const dateString = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
    const firstFileName = files[0].name.replace(/\.[^/.]+$/, ""); // remove extension
    const fileName = `${firstFileName} & ${files.length - 1} others - ${dateString}.kml`;
    
    return new File([blob], fileName, { type: "application/vnd.google-earth.kml+xml" });
  };

  const extractKmlFromFile = async (file: File): Promise<File> => {
    if (file.name.toLowerCase().endsWith('.kmz')) {
      try {
        const zip = new JSZip();
        const contents = await zip.loadAsync(file);
        const kmlFile = Object.keys(contents.files).find(name => name.toLowerCase().endsWith('.kml'));
        if (kmlFile) {
          const kmlText = await contents.files[kmlFile].async('text');
          const blob = new Blob([kmlText], { type: "application/vnd.google-earth.kml+xml" });
          const newName = file.name.replace(/\.kmz$/i, '.kml');
          return new File([blob], newName, { type: "application/vnd.google-earth.kml+xml" });
        }
      } catch (err) {
        console.error("Error extracting KMZ:", err);
        addToast(`Gagal mengekstrak KMZ ${file.name}`, "error");
      }
    }
    return file;
  };

  const handleImportLayer = async (files: File[], preserveBatch = false) => {
    if (files.length === 0) return;
    if (isGenerating || isGeneratingHomepass) {
      addToast("Boundary/POP tidak dapat diganti selama proses generate berlangsung.", "error");
      return;
    }

    // Import KML supports multiple boundary/POP files directly. Keep the
    // original files for the batch API while uploading a combined preview
    // layer to the map for convenience.
    if (!preserveBatch) setBatchFiles(files.length > 1 ? files : []);
    if (files.length > 1) {
      addToast(`${files.length} file dipilih. Generate Design akan memprosesnya sebagai batch.`, "info");
      // Keep each boundary as its own parent layer. The generation request
      // still uses the original files together, but the sidebar stays clear.
      for (const file of files) await handleImportLayer([file], true);
      return;
    }
    
    // Unpack any KMZ files first so the rest of the app only deals with KML
    const kmlFiles = await Promise.all(files.map(extractKmlFromFile));
    
    let fileToUse = kmlFiles[0];
    if (kmlFiles.length > 1) {
      fileToUse = await combineKmlFiles(kmlFiles);
    }

    try {
      const formData = new FormData();
      formData.append("file", fileToUse);
      
      const res = await fetch("/api/proxy/api/upload", {
        method: "POST",
        body: formData,
      });
      
      if (!res.ok) throw new Error("Upload failed");
      
      const resp = await res.json();
      const uploadData = resp.data || resp;
      const url = `/api/proxy${uploadData.url}`;
      const isBoundary = fileToUse.name.toLowerCase().includes('boundary');
      const newLayerId = `import-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const newGroupId = isBoundary ? boundaryGroupKey(fileToUse.name) : layers.find(layer =>
        layer.name.toLowerCase().includes('boundary') && layer.groupId
      )?.groupId || boundaryGroupKey(fileToUse.name);
      const boundaryGroupName = isBoundary ? fileToUse.name : layers.find(layer =>
        layer.name.toLowerCase().includes('boundary') && layer.groupName
      )?.groupName;
      
      const newLayer: LayerConfig = {
        id: newLayerId,
        name: fileToUse.name,
        url,
        visible: true,
        color: "#3b82f6", // Default blue color
        groupId: newGroupId,
        groupName: boundaryGroupName || fileToUse.name.replace(/\.[^.]+$/, '').replace(/(pop|olt|sentral)/ig, '').trim(),
        boundaryName: isBoundary ? fileToUse.name : undefined,
      };
      
      // An imported file belongs to the project currently open. Only the
      // first import after explicitly creating a new project gets a name.
      const prjName = projectNameRef.current || fileToUse.name.replace(/\.[^/.]+$/, "");
      if (!projectNameRef.current) {
        projectNameRef.current = prjName;
        setProjectName(prjName);
      }
      
      setLayers(prev => {
        const updatedLayers = [
          ...prev.map(layer => isBoundary && layer.name.toLowerCase().includes('boundary')
            ? { ...layer, visible: false }
            : layer),
          newLayer,
        ];
        saveProject(prjName, updatedLayers).catch(console.error);
        return updatedLayers;
      });
      
      addToast(`Berhasil mengimpor: ${fileToUse.name}`, "success");
    } catch {
      addToast(`Gagal memuat berkas`, "error");
    }
  };

  const handleBatchGenerate = async () => {
    if (!batchFiles.length || isGenerating) return;
    setIsGenerating(true);
    setGenerationProgress({ stage: "QUEUED", message: "Menyiapkan batch design...", percent: 1 });
    try {
      const formData = new FormData();
      batchFiles.forEach(file => formData.append("files", file, file.name));
      formData.append("config", JSON.stringify({ ...generationConfig, include_homepass: false }));
      if (currentProjectId) formData.append("project_id", currentProjectId);
      const response = await fetch("/api/proxy/generate/batch", { method: "POST", body: formData });
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error?.message || payload.detail || "Batch gagal dibuat");
      const batchId = payload.data.batch_id;
      (payload.data.jobs || []).forEach((job: { job_id?: string }) => job.job_id && rememberJob(job.job_id));
      addToast("Batch generation berjalan maksimal 2 job paralel.", "info");

      const poll = async (): Promise<void> => {
        const result = await fetch(`/api/proxy/generate/batch/${batchId}`, { cache: "no-store" });
        const statePayload = await result.json();
        const state = statePayload.data;
        if (!state) throw new Error("Status batch tidak ditemukan");
        const jobs = state.jobs || [];
        const totalPercent = jobs.length
          ? Math.round(jobs.reduce((sum: number, job: { percent?: number }) => sum + (job.percent || 0), 0) / jobs.length)
          : 100;
        const active = jobs.find((job: { status: string }) => job.status === "RUNNING" || job.status === "QUEUED");
        setGenerationProgress({
          stage: active?.stage || state.status,
          message: active?.message || `${state.completed}/${state.total} design selesai`,
          percent: totalPercent,
        });

        if (state.status === "COMPLETED") {
          const newLayers: LayerConfig[] = jobs
            .filter((job: { status: string; result?: { url?: string }; item_id: string }) => job.status === "COMPLETED" && job.result?.url)
            .map((job: { item_id: string; design_name: string; boundary_name: string; result: { url: string } }) => ({
              id: `design:batch:${batchId}:${job.item_id}`,
              name: job.design_name,
              url: `/api/proxy${job.result.url}`,
              visible: true,
              color: "#22c55e",
              groupId: boundaryGroupKey(job.boundary_name),
              groupName: job.boundary_name,
              designName: job.design_name,
              boundaryName: job.boundary_name,
            } as LayerConfig));
          setLayers(prev => {
            const merged = [...prev, ...newLayers.filter(layer => !prev.some(existing => existing.id === layer.id))];
            saveProject(projectName || "Untitled Project", merged).catch(console.error);
            return merged;
          });
          setBatchFiles([]);
          setHasNetworkCore(newLayers.length > 0);
          setIsGenerating(false);
          setTimeout(() => setGenerationProgress(null), 1500);
          addToast("Batch design berhasil dibuat.", "success");
          return;
        }
        if (state.status === "FAILED") throw new Error("Semua job batch gagal");
        await new Promise(resolve => setTimeout(resolve, 1000));
        return poll();
      };
      await poll();
    } catch (error) {
      console.error("Batch generation failed:", error);
      setIsGenerating(false);
      setGenerationProgress(null);
      addToast(error instanceof Error ? error.message : "Batch generation gagal", "error");
    }
  };

  const handleSmartGenerate = async () => {
    if (batchFiles.length > 0) {
      await handleBatchGenerate();
      return;
    }
    // Determine which layers are which
    const visibleLayers = layers.filter(l => l.visible && l.id !== 'design' && !l.id.startsWith('design:'));
    const boundaryLayers = visibleLayers.filter(l => l.name.toLowerCase().includes('boundary') || l.id === 'boundary');
    const boundaryLayer = boundaryLayers[0];
    const popLayer = visibleLayers.find(l => l.name.toLowerCase().includes('pop') || l.name.toLowerCase().includes('olt'));

    if (boundaryLayers.length > 1) {
      addToast("Pilih satu boundary saja sebelum Generate Design.", "error");
      return;
    }
    
    if (boundaryLayer) {
      // FULL GENERATE (POP is optional)
      setIsGenerating(true);
      setHasNetworkCore(false);
      addToast(popLayer ? "Mengambil data Boundary dan POP dari peta..." : "Mengambil data Boundary (POP akan digenerate otomatis)...", "info");
      try {
        const boundaryRes = await fetch(boundaryLayer.url);
        if (!boundaryRes.ok) throw new Error(`Gagal mengambil file boundary: ${boundaryRes.statusText}`);
        const boundaryBlob = await boundaryRes.blob();
        
        const formData = new FormData();
        formData.append("boundaryFile", boundaryBlob, boundaryLayer.name);
        
        if (popLayer) {
          const popRes = await fetch(popLayer.url);
          if (!popRes.ok) throw new Error(`Gagal mengambil file POP: ${popRes.statusText}`);
          const popBlob = await popRes.blob();
          formData.append("popFile", popBlob, popLayer.name);
        }

        // The primary UI flow is Network Core. The legacy config field is
        // retained for compatibility, but Homepass is now a separate job.
        formData.append("config", JSON.stringify({ ...generationConfig, include_homepass: false }));
        formData.append("mode", "CORE");

        const jobId = `job-${Date.now()}`;
        formData.append("job_id", jobId);
        rememberJob(jobId);

        let eventSource: EventSource | null = null;
        const handleProgress = (event: MessageEvent) => {
          const pData = JSON.parse(event.data);
          if (pData.error) {
            eventSource?.close();
            setIsGenerating(false);
            setHasNetworkCore(false);
            addToast("Generation failed: " + pData.error, "error");
            setGenerationProgress(null);
            return;
          }
          setGenerationProgress({ stage: pData.stage, message: pData.message, percent: pData.percent });
          if (pData.done) {
            eventSource?.close();
            setTimeout(() => setGenerationProgress(null), 1500);
            setIsGenerating(false);
            setHasNetworkCore(Boolean(pData.result));
            
            if (pData.result) {
              const result = pData.result;
              const designId = `design:single:${jobId}`;
              const designGroupId = boundaryLayer.groupId || `boundary:${boundaryLayer.id}`;
              const newDesign: LayerConfig = {
                id: designId,
                name: `FTTH Design - ${boundaryLayer.name}`,
                url: `/api/proxy${result.url}`,
                visible: true,
                color: "#22c55e",
                groupId: designGroupId,
                groupName: boundaryLayer.groupName || boundaryLayer.name,
                designName: boundaryLayer.name,
                boundaryName: boundaryLayer.name,
                status: "COMPLETED",
              };
              setLayers(prev => {
                const newLayers = [...prev, newDesign];
                setFilters(prevFilters => {
                  const generatedFilters = { ...prevFilters, showHouse: false };
                  // We do the side effect here safely because this block only runs once per job completion
                  saveProject(
                    projectName || "Untitled Project",
                    newLayers,
                    generatedFilters,
                  ).catch(console.error);
                  return generatedFilters;
                });
                return newLayers;
              });
              
              if (result.kmz_url) setKmzUrl(`/api/proxy${result.kmz_url}`);
              if (result.csv_url) setCsvUrl(`/api/proxy${result.csv_url}`);
              if (result.stats) setDesignStats(result.stats);
              if (result.validation) setValidationResult(result.validation);
              addToast("Network Core selesai. Generate Homepass tersedia jika titik rumah diperlukan.", "success");
            }
          }
        };

        const response = await fetch("/api/proxy/generate", {
          method: "POST",
          body: formData,
        });

        const resp = await response.json();
        if (resp.success) {
          // The API creates the Redis progress state while accepting the job.
          // Open SSE only after the POST succeeds to avoid reading the state too early.
          eventSource = new EventSource(`/api/proxy/generate/progress/${jobId}`);
          eventSource.onmessage = handleProgress;
          addToast("Pembuatan desain FTTH sedang berjalan di latar belakang...", "info");
        } else {
          addToast("Generation failed: " + (resp.error?.message || resp.detail), "error");
          setGenerationProgress(null);
          setIsGenerating(false);
        }
      } catch (error) {
        console.error("Error generating design:", error);
        addToast("Error generating design. Is the Python API running?", "error");
        setGenerationProgress(null);
        setIsGenerating(false);
      }
    } else if (visibleLayers.length > 0) {
      // CUSTOM GENERATE (Hanya Tarik Kabel)
      const customLayer = visibleLayers[0];
      setIsGenerating(true);
      setHasNetworkCore(false);
      addToast(`Menganalisis file ${customLayer.name} untuk tarik kabel...`, "info");
      try {
        const customRes = await fetch(customLayer.url);
        if (!customRes.ok) throw new Error(`Gagal mengambil file custom mapping: ${customRes.statusText}`);
        const customBlob = await customRes.blob();
        
        const formData = new FormData();
        formData.append("customFile", customBlob, customLayer.name);
        
        const jobId = `job-${Date.now()}`;
        formData.append("job_id", jobId);
        rememberJob(jobId);

        let eventSource: EventSource | null = null;
        const handleProgress = (event: MessageEvent) => {
          const pData = JSON.parse(event.data);
          if (pData.error) {
            eventSource?.close();
            setIsGenerating(false);
            addToast("Generate dari custom KML gagal: " + pData.error, "error");
            setGenerationProgress(null);
            return;
          }
          setGenerationProgress({ stage: pData.stage, message: pData.message, percent: pData.percent });
          if (pData.done) {
            eventSource?.close();
            setTimeout(() => setGenerationProgress(null), 1500);
            setIsGenerating(false);
            
            if (pData.result) {
              const result = pData.result;
              const newDesign: LayerConfig = { id: "design", name: "FTTH Design", url: `/api/proxy${result.url}`, visible: true, color: "#22c55e" };
              setLayers(prev => {
                const newLayers = [...prev.filter(l => l.id !== 'design'), newDesign];
                setFilters(prevFilters => {
                  const generatedFilters = { ...prevFilters, showHouse: false };
                  saveProject(
                    projectName || "Untitled Project",
                    newLayers,
                    generatedFilters,
                  ).catch(console.error);
                  return generatedFilters;
                });
                return newLayers;
              });
              
              if (result.kmz_url) setKmzUrl(`/api/proxy${result.kmz_url}`);
              if (result.csv_url) setCsvUrl(`/api/proxy${result.csv_url}`);
              if (result.stats) setDesignStats(result.stats);
              if (result.validation) setValidationResult(result.validation);
              addToast("Kabel dari KML custom berhasil dibuat!", "success");
            }
          }
        };

        const response = await fetch("/api/proxy/generate-custom", {
          method: "POST",
          body: formData,
        });

        const resp = await response.json();
        if (resp.success) {
          eventSource = new EventSource(`/api/proxy/generate/progress/${jobId}`);
          eventSource.onmessage = handleProgress;
          addToast("Pembuatan kabel dari KML custom sedang berjalan...", "info");
        } else {
          addToast("Generate dari custom KML gagal: " + (resp.error?.message || resp.detail), "error");
          setGenerationProgress(null);
          setIsGenerating(false);
        }
      } catch (error) {
        console.error("Error generating from custom KML:", error);
        addToast("Error generating custom cables. Is the Python API running?", "error");
        setGenerationProgress(null);
        setIsGenerating(false);
      }
    } else {
      addToast("Harap import file Boundary & POP, atau file KML tiang Anda terlebih dahulu.", "error");
    }
  };

  const handleRegenerateCables = async () => {
    setIsRegeneratingCables(true);
    try {
      const formData = new FormData();
      const jobId = `job-${Date.now()}`;
      formData.append("job_id", jobId);
      rememberJob(jobId);
      rememberJob(jobId);

      let eventSource: EventSource | null = null;
      const handleProgress = (event: MessageEvent) => {
        const pData = JSON.parse(event.data);
        if (pData.error) {
          eventSource?.close();
          setIsRegeneratingCables(false);
          addToast("Regenerate kabel gagal: " + pData.error, "error");
          setGenerationProgress(null);
          return;
        }
        setGenerationProgress({ stage: pData.stage, message: pData.message, percent: pData.percent });
        if (pData.done) {
          eventSource?.close();
          setTimeout(() => setGenerationProgress(null), 1500);
          setIsRegeneratingCables(false);

          if (pData.result) {
            const result = pData.result;
            const newDesign: LayerConfig = { id: "design", name: "FTTH Design", url: `/api/proxy${result.url}`, visible: true, color: "#22c55e" };
            setLayers(prev => {
              const newLayers = [...prev.filter(l => l.id !== 'design'), newDesign];
              setFilters(prevFilters => {
                const generatedFilters = { ...prevFilters, showHouse: false };
                saveProject(
                  projectName || "Untitled Project",
                  newLayers,
                  generatedFilters,
                ).catch(console.error);
                return generatedFilters;
              });
              return newLayers;
            });
            
            if (result.kmz_url) setKmzUrl(`/api/proxy${result.kmz_url}`);
            if (result.csv_url) setCsvUrl(`/api/proxy${result.csv_url}`);
            if (result.stats) setDesignStats(result.stats);
            if (result.validation) setValidationResult(result.validation);
            addToast("Regenerate kabel berhasil!", "success");
          }
        }
      };

      const response = await fetch("/api/proxy/regenerate-cables", {
        method: "POST",
        body: formData,
      });

      const resp = await response.json();
      if (resp.success) {
        eventSource = new EventSource(`/api/proxy/generate/progress/${jobId}`);
        eventSource.onmessage = handleProgress;
        addToast("Proses regenerate kabel sedang berjalan...", "info");
      } else {
        addToast("Regenerate kabel gagal: " + (resp.error?.message || resp.detail), "error");
        setGenerationProgress(null);
        setIsRegeneratingCables(false);
      }
    } catch (error) {
      console.error("Error regenerating cables:", error);
      addToast("Error regenerating cables. Is the Python API running?", "error");
      setGenerationProgress(null);
      setIsRegeneratingCables(false);
    }
  };

  const handleGenerateHomepass = async () => {
    if (!hasNetworkCore || isGenerating || isGeneratingHomepass) return;
    setIsGeneratingHomepass(true);
    try {
      const formData = new FormData();
      const jobId = `job-${Date.now()}`;
      formData.append("job_id", jobId);
      const activeBoundary = layers.find(layer => layer.visible && (
        layer.name.toLowerCase().includes("boundary") || layer.id === "boundary"
      ));
      const selectedDesign = layers.find(layer => layer.visible && activeBoundary?.groupId && layer.groupId === activeBoundary.groupId && (
        layer.id.startsWith("design:batch:") || layer.id.startsWith("design:single:") || layer.id === "design"
      )) || layers.find(layer => layer.visible && (
        layer.id.startsWith("design:batch:") || layer.id.startsWith("design:single:") || layer.id === "design"
      ));
      if (currentProjectId) formData.append("project_id", currentProjectId);
      if (selectedDesign?.id.startsWith("design:batch:")) {
        const parts = selectedDesign.id.split(":");
        formData.append("batch_id", parts[2]);
        formData.append("item_id", parts[3]);
      }
      let eventSource: EventSource | null = null;
      const handleProgress = (event: MessageEvent) => {
        const pData = JSON.parse(event.data);
        if (pData.error) {
          eventSource?.close();
          setIsGeneratingHomepass(false);
          setGenerationProgress(null);
          addToast("Generate Homepass gagal: " + pData.error, "error");
          return;
        }
        setGenerationProgress({ stage: pData.stage, message: pData.message, percent: pData.percent });
        if (pData.done) {
          eventSource?.close();
          setTimeout(() => setGenerationProgress(null), 1500);
          setIsGeneratingHomepass(false);
          if (pData.result) {
            const result = pData.result;
            const newDesign: LayerConfig = { id: selectedDesign?.id || "design", name: selectedDesign ? `${selectedDesign.name} + Homepass` : "FTTH Design + Homepass", url: `/api/proxy${result.url}`, visible: true, color: "#22c55e", groupId: selectedDesign?.groupId, groupName: selectedDesign?.groupName, boundaryName: selectedDesign?.boundaryName, status: "COMPLETED" };
            setLayers(prev => {
              const newLayers = selectedDesign
                ? prev.map(layer => layer.id === selectedDesign.id ? newDesign : layer)
                : [...prev.filter(l => l.id !== 'design'), newDesign];
              setFilters(prevFilters => {
                const generatedFilters = { ...prevFilters, showHouse: true };
                saveProject(projectName || "Untitled Project", newLayers, generatedFilters).catch(console.error);
                return generatedFilters;
              });
              return newLayers;
            });
            if (result.kmz_url) setKmzUrl(`/api/proxy${result.kmz_url}`);
            if (result.csv_url) setCsvUrl(`/api/proxy${result.csv_url}`);
            addToast("Homepass berhasil ditambahkan tanpa mengulang routing utama.", "success");
          }
        }
      };
      const response = await fetch("/api/proxy/generate-homepass", { method: "POST", body: formData });
      const resp = await response.json();
      if (resp.success) {
        eventSource = new EventSource(`/api/proxy/generate/progress/${jobId}`);
        eventSource.onmessage = handleProgress;
        eventSource.onerror = () => {
          // EventSource can retry transiently; only surface a failure after
          // the browser has permanently closed the stream.
          if (eventSource?.readyState === EventSource.CLOSED) {
            setIsGeneratingHomepass(false);
            setGenerationProgress(null);
            addToast("Koneksi progress Homepass terputus. Periksa backend lalu coba lagi.", "error");
          }
        };
        addToast("Pembuatan Homepass sedang berjalan...", "info");
      } else {
        setIsGeneratingHomepass(false);
        addToast("Generate Homepass gagal: " + (resp.error?.message || resp.detail), "error");
      }
    } catch (error) {
      console.error("Error generating homepass:", error);
      setIsGeneratingHomepass(false);
      setGenerationProgress(null);
      addToast("Error Generate Homepass. Pastikan API dan worker berjalan.", "error");
    }
  };

  const visibleLayers = layers.filter(l => l.visible);
  const canGenerateHomepass = hasNetworkCore;

  return (
    <div className="dashboard-container">
      {showVersionHistory && currentProjectId && (
        <VersionHistoryPanel 
          projectId={currentProjectId}
          onClose={() => setShowVersionHistory(false)}
          onLoadVersion={(v) => {
            // Re-apply config
            setGenerationConfig(v.config);
            addToast(`Config untuk versi ${v.version} berhasil dimuat. Silakan Generate ulang.`, 'success');
            // We can't automatically fetch the old KML since we don't have object storage yet, 
            // but we can set the stats
            if (v.stats) {
              setDesignStats(v.stats);
            }
            if (v.validation) {
              setValidationResult(v.validation);
            }
            setShowVersionHistory(false);
          }}
          onCompareVersions={(v1, v2) => {
            setCompareVersions([v1, v2]);
            setShowVersionHistory(false);
          }}
        />
      )}

      {compareVersions && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[500]">
          <div className="bg-white rounded-xl shadow-xl w-[600px] max-w-[90vw] max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold text-lg text-gray-800">Compare Versions</h3>
              <button onClick={() => setCompareVersions(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <h4 className="font-medium text-gray-700 mb-4 border-b pb-2">Version {compareVersions[0].version}</h4>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">ODC Count</span>
                      <span className="font-medium">{compareVersions[0].stats?.odc_count || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">ODP Count</span>
                      <span className="font-medium">{compareVersions[0].stats?.odp_count || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Customers</span>
                      <span className="font-medium">{compareVersions[0].stats?.customer_count || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Feeder (km)</span>
                      <span className="font-medium">{compareVersions[0].stats?.feeder_length_km?.toFixed(2) || 0}</span>
                    </div>
                    <div className="mt-4 pt-4 border-t">
                      <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Config</h5>
                      <pre className="text-xs bg-gray-50 p-2 rounded max-h-32 overflow-y-auto">
                        {JSON.stringify(compareVersions[0].config, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
                <div>
                  <h4 className="font-medium text-gray-700 mb-4 border-b pb-2">Version {compareVersions[1].version}</h4>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">ODC Count</span>
                      <span className="font-medium">
                        {compareVersions[1].stats?.odc_count || 0}
                        {(() => {
                          const diff = (compareVersions[1].stats?.odc_count || 0) - (compareVersions[0].stats?.odc_count || 0);
                          return diff !== 0 ? <span className={`ml-2 text-xs ${diff > 0 ? 'text-green-500' : 'text-red-500'}`}>{diff > 0 ? '+' : ''}{diff}</span> : null;
                        })()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">ODP Count</span>
                      <span className="font-medium">
                        {compareVersions[1].stats?.odp_count || 0}
                        {(() => {
                          const diff = (compareVersions[1].stats?.odp_count || 0) - (compareVersions[0].stats?.odp_count || 0);
                          return diff !== 0 ? <span className={`ml-2 text-xs ${diff > 0 ? 'text-green-500' : 'text-red-500'}`}>{diff > 0 ? '+' : ''}{diff}</span> : null;
                        })()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Customers</span>
                      <span className="font-medium">
                        {compareVersions[1].stats?.customer_count || 0}
                        {(() => {
                          const diff = (compareVersions[1].stats?.customer_count || 0) - (compareVersions[0].stats?.customer_count || 0);
                          return diff !== 0 ? <span className={`ml-2 text-xs ${diff > 0 ? 'text-green-500' : 'text-red-500'}`}>{diff > 0 ? '+' : ''}{diff}</span> : null;
                        })()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Feeder (km)</span>
                      <span className="font-medium">
                        {compareVersions[1].stats?.feeder_length_km?.toFixed(2) || 0}
                        {(() => {
                          const diff = (compareVersions[1].stats?.feeder_length_km || 0) - (compareVersions[0].stats?.feeder_length_km || 0);
                          return diff !== 0 ? <span className={`ml-2 text-xs ${diff > 0 ? 'text-red-500' : 'text-green-500'}`}>{diff > 0 ? '+' : ''}{diff.toFixed(2)}</span> : null;
                        })()}
                      </span>
                    </div>
                    <div className="mt-4 pt-4 border-t">
                      <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Config</h5>
                      <pre className="text-xs bg-gray-50 p-2 rounded max-h-32 overflow-y-auto">
                        {JSON.stringify(compareVersions[1].config, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-4 border-t bg-gray-50 flex justify-end">
              <button 
                onClick={() => setCompareVersions(null)}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-md text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      <GenerationConfigModal 
        isOpen={isConfigModalOpen} 
        onClose={() => setIsConfigModalOpen(false)} 
        config={generationConfig} 
        onSave={setGenerationConfig} 
      />
      <Navbar 
        onImportLayer={handleImportLayer} 
        onSmartGenerate={batchFiles.length > 0 || visibleLayers.some((l: LayerConfig) => l.name.toLowerCase().includes('boundary') || l.name.toLowerCase().includes('pop') || l.name.toLowerCase().includes('olt')) ? handleSmartGenerate : undefined}
        isGenerating={isGenerating}
        onRegenerateCables={visibleLayers.some((l: LayerConfig) => l.id === "design") ? handleRegenerateCables : undefined}
        isRegeneratingCables={isRegeneratingCables}
        hasDesign={layers.some(l => l.id === 'design' && l.visible)}
        onGenerateHomepass={handleGenerateHomepass}
        isGeneratingHomepass={isGeneratingHomepass}
        hasNetworkCore={canGenerateHomepass}
        projectName={projectName}
        featureColors={featureColors}
        onConfigClick={() => setIsConfigModalOpen(true)}
        onVersionHistoryClick={() => {
          if (!currentProjectId) {
            addToast("Pilih atau simpan proyek terlebih dahulu untuk melihat versi", "info");
            return;
          }
          setShowVersionHistory(prev => !prev);
        }}
      />
      <div className="map-container" style={{ position: 'relative' }}>
        <Sidebar 
          filters={filters} 
          onToggleFilter={handleToggleFilter} 
          layers={layers} 
          onToggleLayer={toggleLayer}
          kmlTrees={kmlTrees}
          onToggleTreeNode={toggleTreeNode}
          isCollapsed={isSidebarCollapsed}
          onToggle={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          featureColors={featureColors}
          canEditColors={canEditColors}
          onColorChange={canEditColors ? (key, color) => setFeatureColors(prev => ({ ...prev, [key]: color })) : undefined}
          onChangeLayerColor={canEditColors ? handleLayerColorChange : undefined}
          savedProjects={savedProjects}
          onLoadProject={loadProject}
          onUnloadProject={unloadProject}
          onNewProject={unloadProject}
          onDeleteProject={deleteProject}
          currentProjectId={currentProjectId}
          stats={designStats}
          validation={validationResult}
          isGenerationLocked={isGenerating || isGeneratingHomepass}
        />
        <MapComponent 
          layers={layers} 
          onShowMessage={addToast} 
          filters={filters}
          kmlTrees={kmlTrees}
          onTreeLoaded={handleTreeLoaded}
          isSidebarCollapsed={isSidebarCollapsed}
          featureColors={featureColors}
        />
        {generationProgress && (
          <div
            style={{
              position: 'absolute',
              top: '232px',
              right: '20px',
              zIndex: 2000,
            }}
            title="Progress generate"
          >
            <GenerationProgressModal progress={generationProgress} />
          </div>
        )}
      </div>
      
      {/* Download Floating Card */}
      {showDownloadPopup && (kmzUrl || csvUrl) && (
        <div style={{
          position: 'absolute', 
          bottom: '90px', 
          left: '50%', 
          transform: 'translateX(-50%)',
          zIndex: 1000,
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          padding: '16px',
          borderRadius: '16px',
          boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
          border: '1px solid rgba(255, 255, 255, 0.5)',
          minWidth: '280px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#374151' }}>Unduh Hasil Design</h3>
            <button 
              onClick={() => setShowDownloadPopup(false)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex', padding: 0 }}
            >
              <X size={16} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {kmzUrl && (
              <a href={kmzUrl} download style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#3b82f6', color: 'white', textDecoration: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 600, fontSize: '13px', transition: 'background-color 0.2s' }}>
                Download File KMZ (Peta)
              </a>
            )}
            {csvUrl && (
              <a href={csvUrl} download style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#10b981', color: 'white', textDecoration: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 600, fontSize: '13px', transition: 'background-color 0.2s' }}>
                Download File CSV (Data)
              </a>
            )}
          </div>
        </div>
      )}

      {/* Floating Download Button (Bottom Center) */}
      {(kmzUrl || csvUrl) && (
        <button 
          onClick={() => setShowDownloadPopup(!showDownloadPopup)}
          title="Unduh Hasil"
          style={{
            position: 'absolute',
            bottom: '30px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            background: showDownloadPopup ? '#f3f4f6' : 'rgba(255, 255, 255, 0.9)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            color: '#111827',
            border: '1px solid rgba(255, 255, 255, 0.5)',
            borderRadius: '50%',
            width: '50px',
            height: '50px',
            cursor: 'pointer',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 0.2s, box-shadow 0.2s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateX(-50%) scale(1.1)';
            e.currentTarget.style.background = 'white';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateX(-50%) scale(1)';
            e.currentTarget.style.background = showDownloadPopup ? '#f3f4f6' : 'rgba(255, 255, 255, 0.9)';
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
      )}

      {/* Toast Container */}
      <div style={{ position: 'fixed', top: '80px', left: '50%', transform: 'translateX(-50%)', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none' }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '12px', background: 'white', padding: '12px 20px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', borderLeft: `4px solid ${toast.type === 'error' ? '#ef4444' : toast.type === 'success' ? '#10b981' : '#3b82f6'}`, minWidth: '300px' }}>
            {toast.type === 'error' && <AlertCircle size={20} color="#ef4444" />}
            {toast.type === 'success' && <CheckCircle size={20} color="#10b981" />}
            {toast.type === 'info' && <Info size={20} color="#3b82f6" />}
            <span style={{ fontSize: '14px', color: '#374151', fontWeight: 500, flex: 1 }}>{toast.message}</span>
            <button onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex' }}>
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
