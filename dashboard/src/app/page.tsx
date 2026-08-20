"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import JSZip from 'jszip';
import { Navbar } from "../components/Navbar";
import { CheckCircle, AlertCircle, Info, X } from "lucide-react";

import { Sidebar, FeatureFilters } from "../components/Sidebar";

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

export default function Home() {
  const [layers, setLayers] = useState<LayerConfig[]>(initialLayers);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRegeneratingCables, setIsRegeneratingCables] = useState(false);
  const [kmzUrl, setKmzUrl] = useState<string | null>(null);
  const [csvUrl, setCsvUrl] = useState<string | null>(null);
  const [showDownloadPopup, setShowDownloadPopup] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [toasts, setToasts] = useState<{id: number, message: string, type: 'success' | 'error' | 'info'}[]>([]);
  const [filters, setFilters] = useState<FeatureFilters>({
    showPop: true,
    showOdc: true,
    showOdp: true,
    showHouse: true,
    showFeeder: true,
    showDistribution: true,
  });

  const [featureColors, setFeatureColors] = useState<Record<string, string>>({
    pop: '#ef4444',
    odc: '#3b82f6',
    odp: '#10b981',
    house: '#6b7280',
    feeder: '#ef4444',
    distribution: '#3b82f6',
  });

  // Project State
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>("");
  const [savedProjects, setSavedProjects] = useState<{ id: string, name: string, updated_at: string, created_at: string }[]>([]);
  const [kmlTrees, setKmlTrees] = useState<Record<string, KmlNode[]>>({});

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

  const toggleLayer = (id: string) => {
    setLayers(prev => prev.map(layer => 
      layer.id === id ? { ...layer, visible: !layer.visible } : layer
    ));
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
      setSavedProjects(data);
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

  const saveProject = async (name: string, overrideLayers?: LayerConfig[]) => {
    try {
      const payload = {
        name: name,
        layers: overrideLayers || layers,
        filters: filters,
        feature_colors: featureColors
      };

      const url = currentProjectId ? `/api/proxy/api/projects/${currentProjectId}` : '/api/proxy/api/projects';
      const method = currentProjectId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Failed to save project');

      const data = await res.json();
      setCurrentProjectId(data.id);
      setProjectName(data.name);
      addToast('Proyek berhasil disimpan!', 'success');
      fetchProjects(); // Refresh the list
    } catch {
      addToast(`Gagal menyimpan proyek: Pastikan Anda sudah login`, 'error');
    }
  };

  const loadProject = async (id: string) => {
    try {
      const res = await fetch(`/api/proxy/api/projects/${id}`);
      if (!res.ok) throw new Error('Failed to load project');
      
      const data = await res.json();
      setCurrentProjectId(data.id);
      setProjectName(data.name);
      
      const parseJson = (val: any, fallback: any) => {
        if (typeof val === 'string') {
          try { return JSON.parse(val); } catch { return fallback; }
        }
        return val || fallback;
      };

      const rawLayers = parseJson(data.layers, []);
      const uniqueLayers = rawLayers.map((l: LayerConfig, index: number) => {
        if (rawLayers.findIndex((x: LayerConfig) => x.id === l.id) !== index) {
          return { ...l, id: `${l.id}-${Date.now()}-${index}` };
        }
        return l;
      });

      setLayers(uniqueLayers);
      setFilters(parseJson(data.filters, {
        showPop: true, showOdc: true, showOdp: true, showHouse: true, showFeeder: true, showDistribution: true
      }));
      setFeatureColors(parseJson(data.feature_colors, {
        pop: '#ef4444', odc: '#3b82f6', odp: '#10b981', house: '#6b7280', feeder: '#ef4444', distribution: '#3b82f6'
      }));
      addToast('Proyek berhasil dimuat!', 'success');
    } catch {
      addToast(`Gagal memuat proyek: Akses ditolak`, 'error');
    }
  };

  const unloadProject = () => {
    setCurrentProjectId(null);
    setProjectName("");
    setLayers([]);
    setKmzUrl(null);
    setCsvUrl(null);
    setFilters({
      showPop: true, showOdc: true, showOdp: true, showHouse: true, showFeeder: true, showDistribution: true
    });
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

  const handleImportLayer = async (files: File[]) => {
    if (files.length === 0) return;
    
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
      
      const data = await res.json();
      const url = `/api/proxy${data.url}`;
      
      const newLayer: LayerConfig = {
        id: `import-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: fileToUse.name,
        url,
        visible: true,
        color: "#3b82f6" // Default blue color
      };
      
      const prjName = projectName || fileToUse.name.replace(/\.[^/.]+$/, "");
      if (!projectName) {
        setProjectName(prjName);
      }
      
      setLayers(prev => {
        const newLayers = [...prev, newLayer];
        return newLayers;
      });
      
      // Get the latest layers from state (note: this might miss the just-added layer if we don't pass it explicitly, 
      // so we use the functional approach but invoke saveProject outside)
      // Actually, we can just pass the new list of layers directly to saveProject
      const updatedLayers = [...layers, newLayer];
      saveProject(prjName, updatedLayers).catch(console.error);
      
      addToast(`Berhasil mengimpor: ${fileToUse.name}`, "success");
    } catch {
      addToast(`Gagal memuat berkas`, "error");
    }
  };

  const handleSmartGenerate = async () => {
    // Determine which layers are which
    const visibleLayers = layers.filter(l => l.visible && l.id !== 'design');
    const boundaryLayer = visibleLayers.find(l => l.name.toLowerCase().includes('boundary'));
    const popLayer = visibleLayers.find(l => l.name.toLowerCase().includes('pop') || l.name.toLowerCase().includes('olt'));
    
    if (boundaryLayer) {
      // FULL GENERATE (POP is optional)
      setIsGenerating(true);
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

        const response = await fetch("/api/proxy/generate", {
          method: "POST",
          body: formData,
        });
        
        const data = await response.json();
        if (data.status === "success") {
          const newDesign: LayerConfig = { id: "design", name: "FTTH Design", url: `/api/proxy${data.url}`, visible: true, color: "#22c55e" };
          const newLayers = [...layers.filter(l => l.id !== 'design'), newDesign];
          setLayers(newLayers);
          saveProject(projectName || "Untitled Project", newLayers).catch(console.error);
          
          if (data.kmz_url) setKmzUrl(`/api/proxy${data.kmz_url}`);
          if (data.csv_url) setCsvUrl(`/api/proxy${data.csv_url}`);
          addToast("FTTH Design successfully generated and updated!", "success");
        } else {
          addToast("Generation failed: " + data.detail, "error");
        }
      } catch (error) {
        console.error("Error generating design:", error);
        addToast("Error generating design. Is the Python API running?", "error");
      } finally {
        setIsGenerating(false);
      }
    } else if (visibleLayers.length > 0) {
      // CUSTOM GENERATE (Hanya Tarik Kabel)
      const customLayer = visibleLayers[0];
      setIsGenerating(true);
      addToast(`Menganalisis file ${customLayer.name} untuk tarik kabel...`, "info");
      try {
        const customRes = await fetch(customLayer.url);
        if (!customRes.ok) throw new Error(`Gagal mengambil file custom mapping: ${customRes.statusText}`);
        const customBlob = await customRes.blob();
        
        const formData = new FormData();
        formData.append("customFile", customBlob, customLayer.name);

        const response = await fetch("/api/proxy/generate-custom", {
          method: "POST",
          body: formData,
        });

        const data = await response.json();
        if (data.status === "success") {
          const newDesign: LayerConfig = { id: "design", name: "FTTH Design", url: `/api/proxy${data.url}`, visible: true, color: "#22c55e" };
          const newLayers = [...layers.filter(l => l.id !== 'design'), newDesign];
          setLayers(newLayers);
          saveProject(projectName || "Untitled Project", newLayers).catch(console.error);
          
          if (data.kmz_url) setKmzUrl(`/api/proxy${data.kmz_url}`);
          if (data.csv_url) setCsvUrl(`/api/proxy${data.csv_url}`);
          addToast("Kabel dari KML custom berhasil dibuat!", "success");
        } else {
          addToast("Generate dari custom KML gagal: " + data.detail, "error");
        }
      } catch (error) {
        console.error("Error generating from custom KML:", error);
        addToast("Error generating custom cables. Is the Python API running?", "error");
      } finally {
        setIsGenerating(false);
      }
    } else {
      addToast("Harap import file Boundary & POP, atau file KML tiang Anda terlebih dahulu.", "error");
    }
  };

  const handleRegenerateCables = async () => {
    setIsRegeneratingCables(true);
    try {
      const response = await fetch("/api/proxy/regenerate-cables", {
        method: "POST",
      });

      const data = await response.json();
      if (data.status === "success") {
        const newDesign: LayerConfig = { id: "design", name: "FTTH Design", url: `/api/proxy${data.url}`, visible: true, color: "#22c55e" };
        const newLayers = [...layers.filter(l => l.id !== 'design'), newDesign];
        setLayers(newLayers);
        saveProject(projectName || "Untitled Project", newLayers).catch(console.error);
        
        if (data.kmz_url) setKmzUrl(`/api/proxy${data.kmz_url}`);
        if (data.csv_url) setCsvUrl(`/api/proxy${data.csv_url}`);
        addToast("Regenerate kabel berhasil!", "success");
      } else {
        addToast("Regenerate kabel gagal: " + data.detail, "error");
      }
    } catch (error) {
      console.error("Error regenerating cables:", error);
      addToast("Error regenerating cables. Is the Python API running?", "error");
    } finally {
      setIsRegeneratingCables(false);
    }
  };

  const visibleLayers = layers.filter(l => l.visible);

  return (
    <div className="dashboard-container">
      <Navbar 
        onImportLayer={handleImportLayer} 
        onSmartGenerate={visibleLayers.some((l: LayerConfig) => l.name.toLowerCase().includes('boundary') || l.name.toLowerCase().includes('pop') || l.name.toLowerCase().includes('olt')) ? handleSmartGenerate : undefined}
        isGenerating={isGenerating}
        onRegenerateCables={visibleLayers.some((l: LayerConfig) => l.id === "design") ? handleRegenerateCables : undefined}
        isRegeneratingCables={isRegeneratingCables}
        hasDesign={visibleLayers.some((l: LayerConfig) => l.id === "design")}
        projectName={projectName}
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
          onColorChange={(key, color) => setFeatureColors(prev => ({ ...prev, [key]: color }))}
          onChangeLayerColor={handleLayerColorChange}
          savedProjects={savedProjects}
          onLoadProject={loadProject}
          onUnloadProject={unloadProject}
          onDeleteProject={deleteProject}
          currentProjectId={currentProjectId}
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
