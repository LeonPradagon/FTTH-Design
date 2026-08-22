import React, { useState } from 'react';
import { AlertTriangle, CheckCircle, Info, ChevronDown, ChevronUp, X, BarChart3, AlertOctagon } from 'lucide-react';

export interface DesignStats {
  odc_count: number;
  odp_count: number;
  customer_count: number;
  feeder_length_km: number;
  odc_stats?: { odc_id: string; odp_count: number; house_count: number }[];
}

export interface ValidationIssue {
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface ValidationResult {
  status: 'PASS' | 'WARNING' | 'ERROR';
  summary: { errors: number; warnings: number; info: number };
  issues: ValidationIssue[];
}

interface ValidationStatsPanelProps {
  stats: DesignStats | null;
  validation: ValidationResult | null;
  onClose?: () => void;
  inline?: boolean;
}

export default function ValidationStatsPanel({ stats, validation, onClose, inline = false }: ValidationStatsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState<'stats' | 'validation'>(validation?.status !== 'PASS' ? 'validation' : 'stats');

  if (!stats && !validation) return null;

  const containerClass = inline 
    ? `w-full bg-white border-t flex flex-col ${
        validation?.status === 'ERROR' ? 'border-red-300' :
        validation?.status === 'WARNING' ? 'border-amber-300' : 'border-gray-200'
      }`
    : `absolute top-4 right-4 w-80 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border transition-all duration-300 z-[400] flex flex-col ${
        validation?.status === 'ERROR' ? 'border-red-300' :
        validation?.status === 'WARNING' ? 'border-amber-300' : 'border-gray-200'
      }`;

  return (
    <div className={containerClass}>
      {/* Header */}
      <div 
        className="flex items-center justify-between p-3 border-b border-gray-100 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          {validation?.status === 'ERROR' && <AlertOctagon className="w-5 h-5 text-red-500" />}
          {validation?.status === 'WARNING' && <AlertTriangle className="w-5 h-5 text-amber-500" />}
          {validation?.status === 'PASS' && <CheckCircle className="w-5 h-5 text-green-500" />}
          <h3 className="font-semibold text-gray-800 text-sm">Design Summary</h3>
        </div>
        <div className="flex items-center gap-1">
          {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
          {!inline && onClose && (
            <button 
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="p-1 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="flex flex-col max-h-[70vh]">
          {/* Tabs */}
          <div className="flex border-b border-gray-100 p-1">
            <button
              className={`flex-1 py-1.5 text-xs font-medium rounded-md flex justify-center items-center gap-1.5 transition-colors ${
                activeTab === 'stats' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'
              }`}
              onClick={() => setActiveTab('stats')}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              Statistics
            </button>
            <button
              className={`flex-1 py-1.5 text-xs font-medium rounded-md flex justify-center items-center gap-1.5 transition-colors ${
                activeTab === 'validation' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'
              }`}
              onClick={() => setActiveTab('validation')}
            >
              {validation?.status === 'ERROR' && <AlertOctagon className="w-3.5 h-3.5 text-red-500" />}
              {validation?.status === 'WARNING' && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
              {validation?.status === 'PASS' && <CheckCircle className="w-3.5 h-3.5 text-green-500" />}
              Validation
              {((validation?.summary.errors || 0) > 0 || (validation?.summary.warnings || 0) > 0) ? (
                <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] ${
                  (validation?.summary.errors || 0) > 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {(validation?.summary.errors || 0) + (validation?.summary.warnings || 0)}
                </span>
              ) : null}
            </button>
          </div>

          {/* Stats Tab */}
          {activeTab === 'stats' && stats && (
            <div className="p-4 overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100 flex flex-col items-center text-center">
                  <span className="text-2xl font-bold text-gray-800">{stats.odc_count}</span>
                  <span className="text-xs text-gray-500 mt-1">Total ODC</span>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100 flex flex-col items-center text-center">
                  <span className="text-2xl font-bold text-gray-800">{stats.odp_count}</span>
                  <span className="text-xs text-gray-500 mt-1">Total ODP</span>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100 flex flex-col items-center text-center">
                  <span className="text-2xl font-bold text-gray-800">{stats.customer_count}</span>
                  <span className="text-xs text-gray-500 mt-1">Homepass / Houses</span>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100 flex flex-col items-center text-center">
                  <span className="text-2xl font-bold text-gray-800">{stats.feeder_length_km}</span>
                  <span className="text-xs text-gray-500 mt-1">Feeder Length (km)</span>
                </div>
              </div>
              
              {stats.odc_stats && stats.odc_stats.length > 0 && (
                <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-gray-100 text-gray-700">
                      <tr>
                        <th className="px-3 py-2 font-medium">ODC</th>
                        <th className="px-3 py-2 font-medium text-center">ODPs</th>
                        <th className="px-3 py-2 font-medium text-center">Houses</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {stats.odc_stats.map(odc => (
                        <tr key={odc.odc_id} className="hover:bg-gray-50">
                          <td className="px-3 py-1.5 text-gray-800 font-medium">{odc.odc_id}</td>
                          <td className="px-3 py-1.5 text-center text-gray-600">{odc.odp_count}</td>
                          <td className="px-3 py-1.5 text-center text-gray-600">{odc.house_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Validation Tab */}
          {activeTab === 'validation' && validation && (
            <div className="p-3 overflow-y-auto flex-1 bg-gray-50/50">
              {validation.status === 'PASS' ? (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <CheckCircle className="w-10 h-10 text-green-400 mb-2" />
                  <p className="text-sm font-medium text-gray-700">Validasi Berhasil!</p>
                  <p className="text-xs text-gray-500 mt-1">Tidak ditemukan masalah pada desain FTTH.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {validation.issues.map((issue, idx) => (
                    <div 
                      key={idx} 
                      className={`p-3 rounded-lg border text-sm flex gap-3 ${
                        issue.severity === 'ERROR' ? 'bg-red-50 border-red-200 text-red-800' :
                        issue.severity === 'WARNING' ? 'bg-amber-50 border-amber-200 text-amber-800' :
                        'bg-blue-50 border-blue-200 text-blue-800'
                      }`}
                    >
                      <div className="mt-0.5 shrink-0">
                        {issue.severity === 'ERROR' ? <AlertOctagon className="w-4 h-4 text-red-500" /> :
                         issue.severity === 'WARNING' ? <AlertTriangle className="w-4 h-4 text-amber-500" /> :
                         <Info className="w-4 h-4 text-blue-500" />}
                      </div>
                      <div>
                        <p className="font-semibold text-xs opacity-80 mb-0.5">{issue.code}</p>
                        <p className="text-xs leading-relaxed">{issue.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
