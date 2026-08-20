import React from 'react';
import { ChevronLeft, Filter, MapPin, Target, Home, Route, Cable, Layers } from 'lucide-react';
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
  currentProjectId?: string | null;
}

export function Sidebar({ filters, onToggleFilter, layers, onToggleLayer, kmlTrees, onToggleTreeNode, isCollapsed, onToggle, featureColors, onColorChange, onChangeLayerColor, savedProjects = [], onLoadProject, currentProjectId }: SidebarProps) {

  const filterItems: { key: keyof FeatureFilters; colorKey: string; label: string; icon: React.ReactNode }[] = [
    { key: 'showPop', colorKey: 'pop', label: 'Server OLT (POP)', icon: <MapPin size={16} /> },
    { key: 'showOdc', colorKey: 'odc', label: 'ODC (Cabinet)', icon: <Target size={16} /> },
    { key: 'showOdp', colorKey: 'odp', label: 'ODP (Tiang)', icon: <MapPin size={16} /> },
    { key: 'showHouse', colorKey: 'house', label: 'Rumah (HC)', icon: <Home size={16} /> },
    { key: 'showFeeder', colorKey: 'feeder', label: 'Kabel Feeder', icon: <Cable size={16} /> },
    { key: 'showDistribution', colorKey: 'distribution', label: 'Kabel Distribusi', icon: <Route size={16} /> },
  ];

  return (
    <div 
      className={`sidebar-container ${isCollapsed ? 'collapsed' : ''}`}
      style={{
        position: 'absolute',
        top: '80px',
        left: '20px',
        zIndex: 1000,
        backgroundColor: 'rgba(255, 255, 255, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: '16px',
        boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
        border: '1px solid rgba(255, 255, 255, 0.5)',
        width: isCollapsed ? '48px' : '260px',
        maxHeight: 'calc(100vh - 100px)',
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
                onClick={() => onToggleFilter(item.key)}
              >
                {item.icon}
              </div>
              <span style={{ 
                fontSize: '13px', 
                color: filters[item.key] ? '#374151' : '#9ca3af',
                fontWeight: filters[item.key] ? 500 : 400,
                cursor: 'pointer'
              }} onClick={() => onToggleFilter(item.key)}>
                {item.label}
              </span>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {featureColors && onColorChange && (
                <input
                  type="color"
                  value={featureColors[item.colorKey]}
                  onChange={(e) => onColorChange(item.colorKey, e.target.value)}
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
                onClick={() => onToggleFilter(item.key)}
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
        <div style={{ flex: 1, padding: '20px', borderTop: '1px solid rgba(0,0,0,0.05)', overflowY: 'auto' }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: '13px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Proyek Tersimpan</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {savedProjects.map((p) => (
              <div 
                key={p.id}
                onClick={() => onLoadProject?.(p.id)}
                style={{
                  padding: '12px',
                  border: `1px solid ${currentProjectId === p.id ? '#3b82f6' : '#e5e7eb'}`,
                  backgroundColor: currentProjectId === p.id ? '#eff6ff' : 'white',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px'
                }}
              >
                <div style={{ fontWeight: 600, color: currentProjectId === p.id ? '#1e40af' : '#1f2937', fontSize: '13px' }}>
                  {p.name}
                </div>
                <div style={{ fontSize: '11px', color: '#6b7280' }}>
                  {new Date(p.updated_at || p.created_at || "2024-01-01").toLocaleString('id-ID')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
