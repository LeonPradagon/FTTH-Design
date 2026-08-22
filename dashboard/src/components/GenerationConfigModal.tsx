import React, { useState } from 'react';
import { X, Settings, RotateCcw } from 'lucide-react';

export interface GenerationConfig {
  odp_capacity: number;
  odc_capacity: number;
  include_homepass: boolean;
  max_odp_radius_m: number;
  max_odc_radius_m: number;
  max_feeder_length_m: number;
  max_distribution_length_m: number;
  snapping_distance_m: number;
  routing_strategy: 'shortest' | 'priority_road';
}

export const DEFAULT_CONFIG: GenerationConfig = {
  odp_capacity: 10,
  odc_capacity: 4,
  include_homepass: true,
  max_odp_radius_m: 150.0,
  max_odc_radius_m: 500.0,
  max_feeder_length_m: 2000.0,
  max_distribution_length_m: 500.0,
  snapping_distance_m: 50.0,
  routing_strategy: 'shortest',
};

interface GenerationConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: GenerationConfig;
  onSave: (newConfig: GenerationConfig) => void;
}

export default function GenerationConfigModal({ isOpen, onClose, config, onSave }: GenerationConfigModalProps) {
  const [formData, setFormData] = useState<GenerationConfig>(config);

  if (!isOpen) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox'
        ? (e.target as HTMLInputElement).checked
        : type === 'number' ? Number(value) : value
    }));
  };

  const handleReset = () => {
    setFormData(DEFAULT_CONFIG);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-blue-600" />
            <h2 className="text-xl font-bold text-gray-800">Generator Configuration</h2>
          </div>
          <button 
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-full transition-colors text-gray-500"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 text-gray-700">
          <form id="config-form" onSubmit={handleSubmit} className="space-y-6">
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Capacity section */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900 border-b pb-2">Kapasitas Perangkat</h3>
                
                <div>
                  <label className="block text-sm font-medium mb-1">ODP Capacity (Houses)</label>
                  <input type="number" name="odp_capacity" value={formData.odp_capacity} onChange={handleChange} min={1} max={64} className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none" />
                  <p className="text-xs text-gray-500 mt-1">Maksimal pelanggan per ODP (default: 10)</p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">ODC Capacity (ODPs)</label>
                  <input type="number" name="odc_capacity" value={formData.odc_capacity} onChange={handleChange} min={1} max={32} className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none" />
                  <p className="text-xs text-gray-500 mt-1">Maksimal ODP per ODC (default: 4)</p>
                </div>

                <label className="flex items-start gap-3 rounded-md border border-blue-100 bg-blue-50 p-3">
                  <input
                    type="checkbox"
                    name="include_homepass"
                    checked={formData.include_homepass}
                    onChange={handleChange}
                    className="mt-1 h-4 w-4"
                  />
                  <span>
                    <span className="block text-sm font-medium">Export HC & kabel drop</span>
                    <span className="block text-xs text-gray-600 mt-1">
                      Matikan untuk boundary besar agar KMZ lebih cepat dibuat.
                    </span>
                  </span>
                </label>
              </div>

              {/* Radius section */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900 border-b pb-2">Batas Radius Layanan</h3>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Max ODP Radius (m)</label>
                  <input type="number" step="0.1" name="max_odp_radius_m" value={formData.max_odp_radius_m} onChange={handleChange} min={10} max={1000} className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none" />
                  <p className="text-xs text-gray-500 mt-1">Radius ODP ke pelanggan terjauh (default: 150m)</p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Max ODC Radius (m)</label>
                  <input type="number" step="0.1" name="max_odc_radius_m" value={formData.max_odc_radius_m} onChange={handleChange} min={50} max={5000} className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none" />
                  <p className="text-xs text-gray-500 mt-1">Radius ODC ke ODP terjauh (default: 500m)</p>
                </div>
              </div>

              {/* Cable length section */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900 border-b pb-2">Batas Panjang Kabel</h3>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Max Feeder Length (m)</label>
                  <input type="number" step="0.1" name="max_feeder_length_m" value={formData.max_feeder_length_m} onChange={handleChange} min={100} max={20000} className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none" />
                  <p className="text-xs text-gray-500 mt-1">Jarak maksimum kabel feeder dari POP ke ODC</p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Max Distribution Length (m)</label>
                  <input type="number" step="0.1" name="max_distribution_length_m" value={formData.max_distribution_length_m} onChange={handleChange} min={50} max={5000} className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none" />
                  <p className="text-xs text-gray-500 mt-1">Jarak maksimum kabel distribusi ODC ke ODP</p>
                </div>
              </div>

              {/* Routing section */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900 border-b pb-2">Parameter Routing</h3>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Snapping Distance (m)</label>
                  <input type="number" step="0.1" name="snapping_distance_m" value={formData.snapping_distance_m} onChange={handleChange} min={5} max={500} className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none" />
                  <p className="text-xs text-gray-500 mt-1">Toleransi max snap perangkat ke jalan OSM</p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Routing Strategy</label>
                  <select name="routing_strategy" value={formData.routing_strategy} onChange={handleChange} className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none bg-white">
                    <option value="shortest">Shortest Path (Jarak Terpendek)</option>
                    <option value="priority_road">Priority Road (Hindari jalan sempit/gang)</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">Strategi algoritma Dijkstra untuk kabel</p>
                </div>
              </div>

            </div>
          </form>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-100 flex justify-between bg-gray-50 rounded-b-xl">
          <button 
            type="button" 
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Reset to Default</span>
          </button>
          
          <div className="flex gap-3">
            <button 
              type="button" 
              onClick={onClose}
              className="px-5 py-2 text-gray-600 hover:bg-gray-200 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button 
              type="submit" 
              form="config-form"
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors shadow-sm"
            >
              Save Configuration
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
