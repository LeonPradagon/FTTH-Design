import React from 'react';
import { LoaderCircle, CheckCircle2, AlertCircle } from 'lucide-react';

interface GenerationProgress { stage: string; message: string; percent: number; }
interface GenerationProgressModalProps { progress: GenerationProgress | null; }

export default function GenerationProgressModal({ progress }: GenerationProgressModalProps) {
  const [open, setOpen] = React.useState(false);
  if (!progress) return null;
  const isError = progress.stage === 'ERROR';
  const isDone = progress.stage === 'COMPLETED' || progress.percent >= 100;
  const percent = Math.max(0, Math.min(100, progress.percent));
  return (
    <div className="relative ml-2" style={{ zIndex: 6000 }}>
      <button type="button" onClick={() => setOpen(value => !value)} onMouseEnter={() => setOpen(true)} title={progress.message}
        style={{ display: 'flex', alignItems: 'center', gap: '5px', border: `1px solid ${isError ? '#fecaca' : isDone ? '#bbf7d0' : '#bfdbfe'}`, borderRadius: '999px', padding: '6px 9px', background: isError ? '#fff1f2' : isDone ? '#f0fdf4' : '#eff6ff', color: isError ? '#dc2626' : isDone ? '#15803d' : '#2563eb', cursor: 'pointer', fontSize: '11px', fontWeight: 700 }}>
        {isError ? <AlertCircle size={14} /> : isDone ? <CheckCircle2 size={14} /> : <LoaderCircle size={14} className="animate-spin" />}
        <span>{percent}%</span>
      </button>
      {open && <div onMouseLeave={() => setOpen(false)} style={{ position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, width: '270px', padding: '12px', borderRadius: '12px', background: 'white', border: '1px solid #e5e7eb', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}><strong style={{ fontSize: '12px', color: '#1f2937' }}>{isError ? 'Generation gagal' : isDone ? 'Generation selesai' : 'Generating design'}</strong><span style={{ fontSize: '11px', color: '#6b7280' }}>{progress.stage}</span></div>
        <div style={{ fontSize: '12px', color: isError ? '#dc2626' : '#4b5563', lineHeight: 1.4 }}>{progress.message}</div>
        <div style={{ height: '5px', marginTop: '9px', borderRadius: '999px', background: '#e5e7eb', overflow: 'hidden' }}><div style={{ width: `${percent}%`, height: '100%', background: isError ? '#ef4444' : '#2563eb', transition: 'width 300ms ease' }} /></div>
      </div>}
    </div>
  );
}
