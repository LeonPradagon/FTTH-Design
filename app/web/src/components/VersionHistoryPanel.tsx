import React, { useState, useEffect } from 'react';
import { Clock, Copy, Trash2, X, AlertCircle, Play } from 'lucide-react';
import { useSession } from '@/lib/auth-client';

export interface DesignVersion {
  id: string;
  projectId: string;
  version: number;
  config: any;
  stats: any;
  validation?: any;
  status: string;
  createdAt: string;
}

interface VersionHistoryPanelProps {
  projectId: string;
  onClose: () => void;
  onLoadVersion: (version: DesignVersion) => void;
  onCompareVersions: (v1: DesignVersion, v2: DesignVersion) => void;
}

export default function VersionHistoryPanel({ projectId, onClose, onLoadVersion, onCompareVersions }: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<DesignVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  const { data: session } = useSession();

  useEffect(() => {
    fetchVersions();
  }, [projectId]);

  const fetchVersions = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/proxy/api/projects/${projectId}/versions`);
      if (res.ok) {
        const data = await res.json();
        setVersions(data.data || []);
      }
    } catch (err) {
      console.error("Failed to fetch versions:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (versionNumber: number) => {
    if (!confirm(`Are you sure you want to delete version ${versionNumber}?`)) return;
    try {
      const res = await fetch(`/api/proxy/api/projects/${projectId}/versions/${versionNumber}`, {
        method: 'DELETE'
      });
      if (res.ok) fetchVersions();
    } catch (err) {
      console.error("Failed to delete version", err);
    }
  };

  const handleDuplicate = async (versionNumber: number) => {
    try {
      const res = await fetch(`/api/proxy/api/projects/${projectId}/versions/${versionNumber}/duplicate`, {
        method: 'POST'
      });
      if (res.ok) fetchVersions();
    } catch (err) {
      console.error("Failed to duplicate version", err);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedVersions(prev => {
      if (prev.includes(id)) return prev.filter(v => v !== id);
      if (prev.length < 2) return [...prev, id];
      return [prev[1], id]; // keep max 2 selected
    });
  };

  const handleCompare = () => {
    if (selectedVersions.length !== 2) return;
    const v1 = versions.find(v => v.id === selectedVersions[0]);
    const v2 = versions.find(v => v.id === selectedVersions[1]);
    if (v1 && v2) {
      onCompareVersions(v1, v2);
    }
  };

  return (
    <div className="absolute top-16 left-4 w-80 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200 z-[400] flex flex-col max-h-[80vh]">
      <div className="flex items-center justify-between p-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-blue-500" />
          <h3 className="font-semibold text-gray-800 text-sm">Version History</h3>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-full text-gray-400">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-500">Loading versions...</div>
        ) : versions.length === 0 ? (
          <div className="p-4 flex flex-col items-center justify-center text-center gap-2">
            <AlertCircle className="w-8 h-8 text-gray-300" />
            <p className="text-sm text-gray-500">No versions found for this project.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {versions.map(v => (
              <div 
                key={v.id} 
                className={`p-3 rounded-lg border text-sm transition-all ${selectedVersions.includes(v.id) ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}
                onClick={() => toggleSelect(v.id)}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-gray-800">Version {v.version}</span>
                  <span className="text-xs text-gray-500">{new Date(v.createdAt).toLocaleDateString()}</span>
                </div>
                
                <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 mb-3">
                  <div>ODC: <span className="font-medium">{v.stats?.odc_count || 0}</span></div>
                  <div>ODP: <span className="font-medium">{v.stats?.odp_count || 0}</span></div>
                  <div>Customer: <span className="font-medium">{v.stats?.customer_count || 0}</span></div>
                  <div>Feeder: <span className="font-medium">{v.stats?.feeder_length_km ? v.stats.feeder_length_km.toFixed(1) : 0}km</span></div>
                </div>

                <div className="flex items-center gap-2 border-t pt-2 mt-1">
                  <button 
                    onClick={(e) => { e.stopPropagation(); onLoadVersion(v); }}
                    className="flex-1 flex items-center justify-center gap-1 py-1 px-2 bg-gray-100 hover:bg-blue-100 text-gray-700 hover:text-blue-700 rounded transition-colors text-xs font-medium"
                  >
                    <Play className="w-3 h-3" /> Load Config
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleDuplicate(v.version); }}
                    className="p-1 text-gray-400 hover:text-blue-600 rounded hover:bg-gray-100 transition-colors"
                    title="Duplicate"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleDelete(v.version); }}
                    className="p-1 text-gray-400 hover:text-red-600 rounded hover:bg-gray-100 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      
      {selectedVersions.length === 2 && (
        <div className="p-3 border-t bg-gray-50 rounded-b-xl">
          <button 
            onClick={handleCompare}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors"
          >
            Compare Selected ({selectedVersions.length})
          </button>
        </div>
      )}
    </div>
  );
}
