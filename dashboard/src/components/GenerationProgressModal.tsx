import React from 'react';

interface GenerationProgress {
  stage: string;
  message: string;
  percent: number;
}

interface GenerationProgressModalProps {
  progress: GenerationProgress | null;
}

const STAGES = [
  { id: 'STARTING', label: 'Inisialisasi' },
  { id: 'PARSING', label: 'Membaca Input' },
  { id: 'LOADING_ROADS', label: 'Mengambil Peta (OSM)' },
  { id: 'CLUSTERING', label: 'Membuat Cluster' },
  { id: 'ROUTING', label: 'Routing Kabel' },
  { id: 'EXPORTING', label: 'Finalisasi Output' },
  { id: 'COMPLETED', label: 'Selesai' },
];

export default function GenerationProgressModal({ progress }: GenerationProgressModalProps) {
  const [isHovered, setIsHovered] = React.useState(false);

  if (!progress) return null;

  const isError = progress.stage === 'ERROR';

  if (isError) {
    return (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-5">
        <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl shadow-lg flex flex-col gap-2 items-center">
          <div className="flex items-center gap-2 font-bold">
            <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Gagal Generate Design
          </div>
          <span className="text-sm opacity-90 text-center max-w-xs">{progress.message}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[5000] pointer-events-auto transition-all duration-300">
      <div 
        className="group relative bg-white/90 backdrop-blur-md shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-100/50 rounded-2xl overflow-hidden cursor-default transition-all duration-300 ease-out hover:shadow-[0_8px_30px_rgb(59,130,246,0.15)]"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Compact View (Default) */}
        <div className="flex items-center gap-4 px-6 py-3 min-w-[200px]">
          <div className="relative flex items-center justify-center">
            <div className="animate-spin rounded-full h-5 w-5 border-[3px] border-gray-100 border-t-blue-600"></div>
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-gray-800 tracking-tight">Generating...</span>
            <span className="text-xs text-blue-600 font-medium">{progress.percent}%</span>
          </div>
        </div>

        {/* Expanded View (On Hover) */}
        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isHovered ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-6 pb-4 pt-1 border-t border-gray-50/50 bg-gray-50/30">
            <p className="text-xs text-gray-500 mb-3 text-center max-w-[240px] truncate" title={progress.message}>
              {progress.message}
            </p>
            <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-500 ease-out rounded-full"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
