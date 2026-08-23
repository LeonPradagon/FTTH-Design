import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronDown, ChevronRight, Filter, Server, Triangle, Home, Route, Cable, Layers, Trash2, Folder, ArrowLeft, Plus } from 'lucide-react';
import { LayerConfig, KmlNode } from '../app/page';
import { KmlTreeViewer } from './KmlTreeViewer';
import ValidationStatsPanel, { DesignStats, ValidationResult } from './ValidationStatsPanel';

export type FeatureFilters = {
  showPop: boolean;
  showOdc: boolean;
  showOdp: boolean;
  showHouse: boolean;
  showFeeder: boolean;
  showDistribution: boolean;
};

interface SidebarProps {
  filters: FeatureFilters;
  onToggleFilter: (key: keyof FeatureFilters) => void;
  layers: LayerConfig[];
  onToggleLayer: (id: string) => void;
  kmlTrees?: Record<string, KmlNode[]>;
  onToggleTreeNode?: (layerId: string, nodeId: string) => void;
  isCollapsed: boolean;
  onToggle: () => void;
  featureColors?: Record<string, string>;
  canEditColors?: boolean;
  onColorChange?: (key: string, color: string) => void;
  onChangeLayerColor?: (id: string, color: string) => void;
  savedProjects?: { id: string; name: string; updated_at?: string; created_at?: string }[];
  onLoadProject?: (id: string) => void;
  onUnloadProject?: () => void;
  onNewProject?: () => void;
  onDeleteProject?: (id: string) => void;
  currentProjectId?: string | null;
  onBackToProjects?: () => void;
  stats?: DesignStats | null;
  validation?: ValidationResult | null;
  isGenerationLocked?: boolean;
}

export function Sidebar({ filters, onToggleFilter, layers, onToggleLayer, kmlTrees, onToggleTreeNode, isCollapsed, onToggle, featureColors, canEditColors = false, onColorChange, onChangeLayerColor, savedProjects = [], onLoadProject, onUnloadProject, onNewProject, onDeleteProject, currentProjectId, onBackToProjects, stats, validation, isGenerationLocked = false }: SidebarProps) {
  const [projectToDelete, setProjectToDelete] = useState<{id: string, name: string} | null>(null);
  const [isMainFolderCollapsed, setIsMainFolderCollapsed] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({
    pop: true,
    boundary: true,
    design: true,
    lainnya: true
  });

  const filterItems: { key: keyof FeatureFilters; colorKey: string; label: string; icon: React.ReactNode }[] = [
    { key: 'showPop', colorKey: 'pop', label: 'Server OLT (POP)', icon: <Server size={16} /> },
    { key: 'showOdc', colorKey: 'odc', label: 'ODC (Cabinet)', icon: <Triangle size={16} fill="currentColor" /> },
    { key: 'showOdp', colorKey: 'odp', label: 'ODP (Tiang)', icon: <Triangle size={16} fill="currentColor" /> },
    { key: 'showHouse', colorKey: 'house', label: 'Rumah (HC) & Kabel Drop', icon: <Home size={16} /> },
    { key: 'showFeeder', colorKey: 'feeder', label: 'Kabel Feeder', icon: <Cable size={16} /> },
    { key: 'showDistribution', colorKey: 'distribution', label: 'Kabel Distribusi', icon: <Route size={16} /> },
  ];

  const isProjectActive = currentProjectId || layers.length > 0;

  const groups = new Map<string, LayerConfig[]>();
  const groupNames = new Map<string, string>();
  const ungrouped: LayerConfig[] = [];

  layers.forEach(l => {
    if (l.groupId) {
      if (!groups.has(l.groupId)) {
        groups.set(l.groupId, []);
        groupNames.set(l.groupId, l.groupName || 'Batch Design');
      }
      groups.get(l.groupId)!.push(l);
    } else {
      ungrouped.push(l);
    }
  });

  const [expandedLayers, setExpandedLayers] = useState<Record<string, boolean>>({});

  const renderLayerItem = (layer: LayerConfig) => {
    const hasTree = kmlTrees && kmlTrees[layer.id] && kmlTrees[layer.id].length > 0;
    const isLayerExpanded = expandedLayers[layer.id];

    const isBoundary = layer.name.toLowerCase().includes('boundary') || layer.id === 'boundary';

    return (
      <React.Fragment key={layer.id}>
        <div 
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: isGenerationLocked ? 'not-allowed' : 'pointer',
            opacity: isGenerationLocked ? 0.7 : 1,
            padding: '4px 6px',
            borderRadius: '4px',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#f9fafb'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          onClick={() => { if (!isGenerationLocked) onToggleLayer(layer.id); }}
          title={isGenerationLocked ? "Layer tidak dapat diganti selama proses generate" : layer.name}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden' }}>
            {hasTree ? (
              <div 
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedLayers(prev => ({ ...prev, [layer.id]: !prev[layer.id] }));
                }}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', color: '#9ca3af', padding: '2px' }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#4b5563'}
                onMouseLeave={(e) => e.currentTarget.style.color = '#9ca3af'}
              >
                {isLayerExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </div>
            ) : (
              <div style={{ width: '18px' }} />
            )}
            <div style={{ 
              width: '20px', 
              height: '20px', 
              borderRadius: '4px', 
              backgroundColor: `${layer.color || '#9ca3af'}15`, 
              color: layer.color || '#9ca3af',
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              flexShrink: 0
            }}>
              <Layers size={12} />
            </div>
            <span style={{ fontSize: '12px', color: '#4b5563', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '110px' }} title={layer.name}>
              {layer.name}
            </span>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isBoundary && canEditColors && onChangeLayerColor && (
              <input
                type="color"
                value={layer.color || '#3b82f6'}
                onChange={(e) => {
                  e.stopPropagation();
                  onChangeLayerColor(layer.id, e.target.value);
                }}
                style={{
                  width: '20px',
                  height: '20px',
                  padding: 0,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  background: 'transparent'
                }}
                title={`Ubah warna ${layer.name}`}
              />
            )}
            <div 
              style={{
                width: '28px',
                height: '16px',
                backgroundColor: layer.visible ? '#10b981' : '#e5e7eb',
                borderRadius: '20px',
                position: 'relative',
                transition: 'background-color 0.2s ease',
                flexShrink: 0
              }}
            >
              <div 
                style={{
                  width: '12px',
                  height: '12px',
                  backgroundColor: 'white',
                  borderRadius: '50%',
                  position: 'absolute',
                  top: '2px',
                  left: layer.visible ? '14px' : '2px',
                  transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                }}
              />
            </div>
          </div>
        </div>

        {isLayerExpanded && hasTree && onToggleTreeNode && (
          <div style={{ marginLeft: '26px', paddingLeft: '8px', borderLeft: '1px solid #e5e7eb', marginBottom: '4px', marginTop: '2px' }}>
            <KmlTreeViewer 
              nodes={kmlTrees[layer.id]} 
              layerId={layer.id} 
              onToggle={onToggleTreeNode} 
            />
          </div>
        )}
      </React.Fragment>
    );
  };

  const renderFolder = (title: string, folderKey: string, folderLayers: LayerConfig[]) => {
    if (folderLayers.length === 0) return null;
    const isCollapsed = collapsedFolders[folderKey];
    const allVisible = folderLayers.every(l => l.visible);
    const someVisible = folderLayers.some(l => l.visible);
    
    return (
      <div key={folderKey} style={{ display: 'flex', flexDirection: 'column' }}>
        <div 
          onClick={() => setCollapsedFolders(p => ({ ...p, [folderKey]: !p[folderKey] }))}
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between', 
            padding: '4px 6px', 
            borderRadius: '4px', 
            cursor: 'pointer', 
            transition: 'background-color 0.2s',
            margin: '1px 0'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ color: '#9ca3af', display: 'flex' }}>
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </div>
            <Folder size={14} color="#6b7280" />
            <span style={{ fontSize: '13px', fontWeight: 500, color: '#4b5563' }}>{title} ({folderLayers.length})</span>
          </div>
          
          <div 
            onClick={(e) => {
              e.stopPropagation();
              folderLayers.forEach(l => {
                if (l.visible === allVisible) onToggleLayer(l.id);
              });
            }}
            style={{
              width: '28px',
              height: '16px',
              backgroundColor: allVisible ? '#10b981' : (someVisible ? '#93c5fd' : '#e5e7eb'),
              borderRadius: '20px',
              position: 'relative',
              transition: 'background-color 0.2s ease',
              flexShrink: 0
            }}
            title={allVisible ? "Sembunyikan Semua" : "Tampilkan Semua"}
          >
            <div 
              style={{
                width: '12px',
                height: '12px',
                backgroundColor: 'white',
                borderRadius: '50%',
                position: 'absolute',
                top: '2px',
                left: allVisible ? '14px' : (someVisible ? '8px' : '2px'),
                transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
              }}
            />
          </div>
        </div>
        
        {!isCollapsed && (
          <div style={{ paddingLeft: '14px', display: 'flex', flexDirection: 'column', gap: '2px', borderLeft: '1px solid #e5e7eb', marginLeft: '12px', marginTop: '2px', marginBottom: '4px' }}>
            {folderLayers.map(layer => renderLayerItem(layer))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div 
      className={`sidebar-container ${isCollapsed ? 'collapsed' : ''}`}
      style={{
        position: 'absolute',
        top: '0',
        left: '0',
        bottom: '0',
        height: '100%',
        zIndex: 1000,
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: '0',
        boxShadow: '4px 0 15px rgba(0, 0, 0, 0.05)',
        borderRight: '1px solid rgba(0, 0, 0, 0.08)',
        width: isCollapsed ? '48px' : '280px',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div 
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: isCollapsed ? 'center' : 'space-between',
          padding: isCollapsed ? '12px 0' : '16px 20px',
          borderBottom: isCollapsed ? 'none' : '1px solid rgba(0,0,0,0.05)',
        }}
      >
        {!isCollapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isProjectActive ? (
              <>
                <button
                  onClick={onBackToProjects}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: '4px',
                    marginRight: '2px',
                    cursor: 'pointer',
                    color: '#4b5563',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '4px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  title="Kembali ke Daftar Proyek"
                >
                  <ArrowLeft size={18} />
                </button>
                <Filter size={18} color="#4b5563" />
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#1f2937', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }} title={savedProjects.find(p => p.id === currentProjectId)?.name || 'Proyek Baru'}>
                  {savedProjects.find(p => p.id === currentProjectId)?.name || 'Proyek Baru'}
                </h3>
              </>
            ) : (
              <>
                <Layers size={18} color="#4b5563" />
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#1f2937' }}>Dashboard</h3>
              </>
            )}
          </div>
        )}
        <button 
          onClick={onToggle}
          style={{
            background: isCollapsed ? '#f3f4f6' : 'transparent',
            border: 'none',
            borderRadius: '8px',
            padding: '6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#4b5563',
            transition: 'background 0.2s',
          }}
          title={isCollapsed ? "Expand Filters" : "Collapse"}
        >
          {isCollapsed ? <Filter size={18} /> : <ChevronLeft size={20} />}
        </button>
      </div>

      {/* Content */}
      <div 
        style={{
          padding: '16px 20px',
          display: isCollapsed ? 'none' : 'flex',
          flexDirection: 'column',
          gap: '12px',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto'
        }}
      >
        {!isProjectActive ? (
          // PROJECT LIST MODE
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#4b5563' }}>Proyek Tersimpan</h3>
              <button
                onClick={() => { if (!isGenerationLocked && onNewProject) onNewProject(); }}
                disabled={isGenerationLocked}
                style={{
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  background: isGenerationLocked ? '#e5e7eb' : '#3b82f6',
                  color: isGenerationLocked ? '#9ca3af' : 'white',
                  cursor: isGenerationLocked ? 'not-allowed' : 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <Plus size={14} /> Baru
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', flex: 1 }}>
              {savedProjects.length === 0 && <div style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', marginTop: '20px' }}>Belum ada proyek tersimpan. Silakan buat proyek baru.</div>}
              {savedProjects.map((p) => (
                <div 
                  key={p.id}
                  className="project-item"
                  style={{
                    position: 'relative',
                    padding: '12px 14px',
                    border: '1px solid #e5e7eb',
                    backgroundColor: 'white',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                  }}
                  onClick={() => {
                    if (isGenerationLocked) return;
                    onLoadProject?.(p.id);
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#3b82f6'; e.currentTarget.style.boxShadow = '0 2px 4px rgba(59,130,246,0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)'; }}
                >
                  <div style={{ fontWeight: 600, color: '#1f2937', fontSize: '14px', paddingRight: '24px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: '12px', color: '#6b7280' }}>
                    {new Date(p.updated_at || p.created_at || "2024-01-01").toLocaleDateString('id-ID')}
                  </div>
                  
                  {onDeleteProject && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setProjectToDelete({ id: p.id, name: p.name });
                      }}
                      style={{
                        position: 'absolute',
                        right: '10px',
                        top: '12px',
                        background: 'transparent',
                        border: 'none',
                        color: '#ef4444',
                        cursor: 'pointer',
                        padding: '6px',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: 0,
                        transition: 'opacity 0.2s, background-color 0.2s'
                      }}
                      className="delete-btn"
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fee2e2'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                      title="Hapus Proyek"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                  <style dangerouslySetInnerHTML={{__html: `
                    .project-item:hover .delete-btn { opacity: 0.6 !important; }
                    .project-item .delete-btn:hover { opacity: 1 !important; }
                  `}} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          // PROJECT DETAIL MODE
          <>
            {filterItems.map((item) => (
              <div 
                key={item.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                }}
                onClick={() => onToggleFilter(item.key)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div 
                    style={{ 
                      color: featureColors ? featureColors[item.colorKey] : '#374151',
                      display: 'flex',
                      alignItems: 'center',
                      opacity: filters[item.key] ? 1 : 0.4,
                      cursor: 'pointer'
                    }}
                  >
                    {item.icon}
                  </div>
                  <span style={{ 
                    fontSize: '13px', 
                    color: filters[item.key] ? '#374151' : '#9ca3af',
                    fontWeight: filters[item.key] ? 500 : 400,
                    cursor: 'pointer'
                  }}>
                    {item.label}
                  </span>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {canEditColors && featureColors && onColorChange && (
                    <input
                      type="color"
                      value={featureColors[item.colorKey]}
                      onChange={(e) => onColorChange(item.colorKey, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: '24px',
                        height: '24px',
                        padding: 0,
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        background: 'transparent'
                      }}
                      title={`Ubah warna ${item.label}`}
                    />
                  )}
                  <div 
                    style={{
                      width: '36px',
                      height: '20px',
                      borderRadius: '10px',
                      backgroundColor: filters[item.key] ? (featureColors ? featureColors[item.colorKey] : '#10b981') : '#e5e7eb',
                      position: 'relative',
                      transition: 'background-color 0.2s',
                      cursor: 'pointer'
                    }}
                  >
                    <div style={{
                      width: '16px',
                      height: '16px',
                      backgroundColor: 'white',
                      borderRadius: '50%',
                      position: 'absolute',
                      top: '2px',
                      left: filters[item.key] ? '18px' : '2px',
                      transition: 'left 0.2s',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                    }} />
                  </div>
                </div>
              </div>
            ))}

            <div style={{ height: '1px', backgroundColor: '#e5e7eb', margin: '8px 0' }} />
            
            {/* Main Folder (Project) */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div 
                onClick={() => setIsMainFolderCollapsed(!isMainFolderCollapsed)}
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '6px', 
                  cursor: 'pointer',
                  padding: '4px 0',
                  color: '#374151',
                  fontWeight: 600,
                  fontSize: '14px',
                  marginBottom: '4px'
                }}
              >
                <div style={{ color: '#6b7280', display: 'flex' }}>
                  {isMainFolderCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </div>
                <Folder size={16} color="#3b82f6" fill="#bfdbfe" />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {savedProjects.find(p => p.id === currentProjectId)?.name || 'Proyek Baru'}
                </span>
              </div>
              
              {!isMainFolderCollapsed && (
                <div style={{ paddingLeft: '14px', borderLeft: '1px solid #e5e7eb', marginLeft: '7px', display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' }}>
                  {Array.from(groups.entries()).map(([groupId, groupLayers]) => 
                    renderFolder(groupNames.get(groupId) || 'Batch Design', groupId, groupLayers)
                  )}
                  {ungrouped.length > 0 && renderFolder("Lainnya", "lainnya", ungrouped)}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {projectToDelete && typeof document !== 'undefined' && createPortal(
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(4px)',
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <div style={{
            background: 'white',
            borderRadius: '16px',
            padding: '24px',
            width: '340px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            animation: 'slideUp 0.3s ease-out'
          }}>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: '#111827' }}>Konfirmasi Hapus</h3>
            <p style={{ margin: 0, fontSize: '14px', color: '#4b5563', lineHeight: '1.5' }}>
              Apakah Anda yakin ingin menghapus proyek <b>&quot;{projectToDelete.name}&quot;</b>? Tindakan ini tidak dapat dibatalkan.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }}>
              <button 
                onClick={() => setProjectToDelete(null)}
                style={{
                  padding: '10px 16px',
                  borderRadius: '8px',
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#374151',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                Batal
              </button>
              <button 
                onClick={() => {
                  if (onDeleteProject) onDeleteProject(projectToDelete.id);
                  setProjectToDelete(null);
                }}
                style={{
                  padding: '10px 16px',
                  borderRadius: '8px',
                  border: 'none',
                  background: '#ef4444',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#dc2626'}
                onMouseLeave={(e) => e.currentTarget.style.background = '#ef4444'}
              >
                Hapus Proyek
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
