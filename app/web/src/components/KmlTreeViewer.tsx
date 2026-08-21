import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, MapPin, Route, Hexagon } from 'lucide-react';
import { KmlNode } from '../app/page';

interface KmlTreeViewerProps {
  nodes: KmlNode[];
  layerId: string;
  onToggle: (layerId: string, nodeId: string) => void;
  level?: number;
}

export function KmlTreeViewer({ nodes, layerId, onToggle, level = 0 }: KmlTreeViewerProps) {
  return (
    <div style={{ paddingLeft: level === 0 ? '0px' : '16px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {nodes.map(node => (
        <KmlTreeNodeItem 
          key={node.id} 
          node={node} 
          layerId={layerId} 
          onToggle={onToggle} 
          level={level} 
        />
      ))}
    </div>
  );
}

function KmlTreeNodeItem({ node, layerId, onToggle, level }: { node: KmlNode, layerId: string, onToggle: (layerId: string, nodeId: string) => void, level: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasChildren = node.children && node.children.length > 0;

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(!isExpanded);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(layerId, node.id);
  };

  const getIcon = () => {
    if (node.type === 'folder') return <Folder size={14} color="#6b7280" />;
    if (node.geomType === 'LineString') return <Route size={14} color="#3b82f6" />;
    if (node.geomType === 'Polygon') return <Hexagon size={14} color="#8b5cf6" />;
    return <MapPin size={14} color="#ef4444" />;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div 
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '2px 0',
          cursor: 'pointer',
          borderRadius: '4px',
        }}
        onClick={hasChildren ? handleToggleExpand : handleCheckboxClick}
      >
        <div style={{ width: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {hasChildren ? (
            <div onClick={handleToggleExpand} style={{ padding: '2px', cursor: 'pointer', color: '#9ca3af' }}>
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </div>
          ) : <div style={{ width: '14px' }} />}
        </div>
        
        {/* Checkbox */}
        <div 
          onClick={handleCheckboxClick}
          style={{ 
            width: '14px', 
            height: '14px', 
            borderRadius: '3px',
            border: `1px solid ${node.visible ? '#3b82f6' : '#d1d5db'}`,
            backgroundColor: node.visible ? '#3b82f6' : 'white',
            margin: '0 6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {node.visible && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
          {getIcon()}
          <span style={{ 
            fontSize: '12px', 
            color: '#4b5563', 
            whiteSpace: 'nowrap', 
            overflow: 'hidden', 
            textOverflow: 'ellipsis',
            maxWidth: '150px'
          }} title={node.name}>
            {node.name}
          </span>
        </div>
      </div>

      {hasChildren && isExpanded && (
        <KmlTreeViewer nodes={node.children!} layerId={layerId} onToggle={onToggle} level={level + 1} />
      )}
    </div>
  );
}
