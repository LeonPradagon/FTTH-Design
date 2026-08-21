import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronDown, ChevronRight, Filter, MapPin, Target, Home, Route, Cable, Layers, Trash2 } from 'lucide-react';
import { LayerConfig, KmlNode } from '../app/page';
import { KmlTreeViewer } from './KmlTreeViewer';

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
  onColorChange?: (key: string, color: string) => void;
  onChangeLayerColor?: (id: string, color: string) => void;
  savedProjects?: { id: string; name: string; updated_at?: string; created_at?: string }[];
  onLoadProject?: (id: string) => void;
  onUnloadProject?: () => void;
  onDeleteProject?: (id: string) => void;
  currentProjectId?: string | null;
}

export function Sidebar({ filters, onToggleFilter, layers, onToggleLayer, kmlTrees, onToggleTreeNode, isCollapsed, onToggle, featureColors, onColorChange, onChangeLayerColor, savedProjects = [], onLoadProject, onUnloadProject, onDeleteProject, currentProjectId }: SidebarProps) {
  const [isProjectsExpanded, setIsProjectsExpanded] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<{id: string, name: string} | null>(null);

  const filterItems: { key: keyof FeatureFilters; colorKey: string; label: string; icon: React.ReactNode }[] = [
    { key: 'showPop', colorKey: 'pop', label: 'Server OLT (POP)', icon: <MapPin size={16} /> },
    { key: 'showOdc', colorKey: 'odc', label: 'ODC (Cabinet)', icon: <Target size={16} /> },
    { key: 'showOdp', colorKey: 'odp', label: 'ODP (Tiang)', icon: <MapPin size={16} /> },
    { key: 'showHouse', colorKey: 'house', label: 'Rumah (HC) & Kabel Drop', icon: <Home size={16} /> },
    { key: 'showFeeder', colorKey: 'feeder', label: 'Kabel Feeder', icon: <Cable size={16} /> },
    { key: 'showDistribution', colorKey: 'distribution', label: 'Kabel Distribusi', icon: <Route size={16} /> },
  ];

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
            <Filter size={18} color="#4b5563" />
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#1f2937' }}>Filter Tampilan</h3>
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
              {featureColors && onColorChange && (
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

        {!isCollapsed && (
          <>
            <div style={{ height: '1px', backgroundColor: '#e5e7eb', margin: '8px 0' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <Layers size={16} color="#4b5563" />
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#1f2937' }}>Filter Berkas</h3>
            </div>
            
            {layers.map((layer) => (
            <React.Fragment key={layer.id}>
              <div 
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  padding: '4px 0'
                }}
                onClick={() => onToggleLayer(layer.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
                  <div style={{ 
                    width: '28px', 
                    height: '28px', 
                    borderRadius: '6px', 
                    backgroundColor: `${layer.color || '#9ca3af'}15`, 
                    color: layer.color || '#9ca3af',
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    flexShrink: 0
                  }}>
                    <Layers size={14} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '14px', color: '#374151', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '130px' }} title={layer.name}>
                      {layer.name}
                    </span>
                  </div>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {onChangeLayerColor && (
                    <input
                      type="color"
                      value={layer.color || '#3b82f6'}
                      onChange={(e) => {
                        e.stopPropagation(); // prevent triggering onToggleLayer
                        onChangeLayerColor(layer.id, e.target.value);
                      }}
                      style={{
                        width: '24px',
                        height: '24px',
                        padding: 0,
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        background: 'transparent'
                      }}
                      title={`Ubah warna ${layer.name}`}
                    />
                  )}
                  {/* iOS Style Toggle Switch */}
                  <div 
                    style={{
                      width: '36px',
                      height: '20px',
                      backgroundColor: layer.visible ? '#10b981' : '#e5e7eb',
                      borderRadius: '20px',
                      position: 'relative',
                      transition: 'background-color 0.2s ease',
                      flexShrink: 0
                    }}
                  >
                    <div 
                      style={{
                        width: '16px',
                        height: '16px',
                        backgroundColor: 'white',
                        borderRadius: '50%',
                        position: 'absolute',
                        top: '2px',
                        left: layer.visible ? '18px' : '2px',
                        transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Tree Viewer for this layer */}
              {layer.visible && kmlTrees && kmlTrees[layer.id] && onToggleTreeNode && (
                <div style={{ marginLeft: '12px', paddingLeft: '8px', borderLeft: '1px solid #e5e7eb', marginBottom: '8px' }}>
                  <KmlTreeViewer 
                    nodes={kmlTrees[layer.id]} 
                    layerId={layer.id} 
                    onToggle={onToggleTreeNode} 
                  />
                </div>
              )}
            </React.Fragment>
            ))}
          </>
        )}
      </div>

      {/* Database Projects Section */}
      {!isCollapsed && savedProjects && savedProjects.length > 0 && (
        <div style={{ padding: '0', borderTop: '1px solid rgba(0,0,0,0.05)', backgroundColor: '#f9fafb' }}>
          <div 
            onClick={() => setIsProjectsExpanded(!isProjectsExpanded)}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'space-between', 
              padding: '16px 20px', 
              cursor: 'pointer',
              userSelect: 'none'
            }}
          >
            <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Proyek Tersimpan ({savedProjects.length})
            </h4>
            {isProjectsExpanded ? <ChevronDown size={16} color="#6b7280" /> : <ChevronRight size={16} color="#6b7280" />}
          </div>
          
          {isProjectsExpanded && (
            <div style={{ display: 'flex', flexDirection: 'column', padding: '0 20px 20px 20px', maxHeight: '250px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {savedProjects.map((p) => (
                  <div 
                    key={p.id}
                    className="project-item"
                    style={{
                      position: 'relative',
                      padding: '10px 12px',
                      border: `1px solid ${currentProjectId === p.id ? '#3b82f6' : '#e5e7eb'}`,
                      backgroundColor: currentProjectId === p.id ? '#eff6ff' : 'white',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px'
                    }}
                  >
                    <div 
                      onClick={() => {
                        if (currentProjectId === p.id && onUnloadProject) {
                          onUnloadProject();
                        } else {
                          onLoadProject?.(p.id);
                        }
                      }}
                      style={{ flex: 1 }}
                    >
                      <div style={{ fontWeight: 600, color: currentProjectId === p.id ? '#1e40af' : '#1f2937', fontSize: '13px', paddingRight: '24px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </div>
                      <div style={{ fontSize: '11px', color: '#6b7280' }}>
                        {new Date(p.updated_at || p.created_at || "2024-01-01").toLocaleDateString('id-ID')}
                      </div>
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
                          padding: '4px',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          opacity: 0.6,
                          transition: 'opacity 0.2s, background-color 0.2s'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.backgroundColor = '#fee2e2'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.backgroundColor = 'transparent'; }}
                        title="Hapus Proyek"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
