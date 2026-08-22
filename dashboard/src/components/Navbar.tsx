import React, { useState, useRef } from 'react';
import { Upload, X, Home, Info, Cable, User, Server, Triangle, Settings } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { AccountCenterModal } from './AccountCenterModal';
import { useSession } from '@/lib/auth-client';
import { DEFAULT_FEATURE_COLORS } from '@/lib/feature-colors';

interface NavbarProps {
  onImportLayer: (files: File[]) => void;
  onSmartGenerate?: () => void;
  isGenerating?: boolean;
  onRegenerateCables?: () => void;
  isRegeneratingCables?: boolean;
  hasDesign?: boolean;
  featureColors?: Record<string, string>;
  projectName?: string | null;
  onConfigClick?: () => void;
  onVersionHistoryClick?: () => void;
}

export function Navbar({ 
  onImportLayer, 
  onSmartGenerate,
  isGenerating, 
  onRegenerateCables, 
  isRegeneratingCables, 
  hasDesign,
  featureColors,
  onConfigClick,
  onVersionHistoryClick,
}: NavbarProps) {
  const [showInfo, setShowInfo] = useState(false);
  const [showAccountCenter, setShowAccountCenter] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: session } = useSession();

  const legendItems = [
    { label: "Server OLT (POP)", desc: "Titik pusat / sentral", color: featureColors?.pop || DEFAULT_FEATURE_COLORS.pop, shape: "server" },
    { label: "ODC (Cabinet)", desc: "Titik distribusi utama", color: featureColors?.odc || DEFAULT_FEATURE_COLORS.odc, shape: "triangle" },
    { label: "ODP (Tiang)", desc: "Titik distribusi ke rumah", color: featureColors?.odp || DEFAULT_FEATURE_COLORS.odp, shape: "triangle" },
    { label: "Rumah (HC)", desc: "Titik pelanggan / homepass", color: featureColors?.house || DEFAULT_FEATURE_COLORS.house, shape: "house" },
    { label: "Kabel Feeder", desc: "Jalur utama (POP ke ODC)", color: featureColors?.feeder || DEFAULT_FEATURE_COLORS.feeder, shape: "line" },
    { label: "Kabel Distribusi", desc: "Jalur cabang (ODC ke ODP)", color: featureColors?.distribution || DEFAULT_FEATURE_COLORS.distribution, shape: "line" },
    { label: "Kabel Drop", desc: "ODP ke rumah; mengikuti filter HC", color: featureColors?.house || DEFAULT_FEATURE_COLORS.house, shape: "line" },
  ];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onImportLayer(Array.from(e.target.files));
    }
    // Clear input so same file can be uploaded again if needed
    e.target.value = '';
  };

  return (
    <>
      {/* Slim Top Navbar */}
      <div className="top-navbar">
        {/* Left: Logo / Title */}
        <div className="navbar-group">
          <h1 className="navbar-title">FTTH Design</h1>
        </div>

        {/* Right: Actions */}
        <div className="navbar-group">
          {session?.user && (
            <div style={{ display: 'flex', alignItems: 'center', marginRight: '16px', borderRight: '1px solid #e5e7eb', paddingRight: '16px' }}>
              <button 
                onClick={() => setShowAccountCenter(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  borderRadius: '9999px',
                  border: '1px solid #e5e7eb',
                  padding: '4px 16px 4px 12px',
                  background: 'white',
                  cursor: 'pointer',
                  gap: '12px',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.backgroundColor = '#f9fafb'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.backgroundColor = 'white'; }}
                title="Buka Account Center"
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '50%', background: '#f3f4f6', color: '#4b5563' }}>
                  <User size={18} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', color: '#9ca3af', textTransform: 'uppercase', lineHeight: 1 }}>ACCOUNT</span>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#1f2937', marginTop: '2px' }}>{session.user.email}</span>
                </div>
              </button>

              {showAccountCenter && (
                <AccountCenterModal 
                  userEmail={session.user.email}
                  userRole={(session.user as { role?: string }).role || 'user'}
                  onClose={() => setShowAccountCenter(false)} 
                />
              )}
            </div>
          )}

          <input 
            type="file" 
            accept=".kml,.kmz"
            multiple
            ref={fileInputRef} 
            style={{ display: 'none' }} 
            onChange={handleFileChange} 
          />
          {onRegenerateCables && (
            <button 
              onClick={onRegenerateCables} 
              disabled={isRegeneratingCables || !hasDesign}
              className={`regenerate-cable-btn ${isRegeneratingCables ? 'loading' : ''}`}
              title={!hasDesign ? "Generate design terlebih dahulu" : "Regenerate jalur kabel tanpa mengubah posisi tiang"}
              style={{ marginLeft: '8px', cursor: (isRegeneratingCables || !hasDesign) ? 'not-allowed' : 'pointer' }}
            >
              <Cable size={14} style={{ marginRight: '6px' }} />
              {isRegeneratingCables ? "..." : "Regenerate Kabel"}
            </button>
          )}

          {onSmartGenerate && (
            <div className="flex items-center">
              <button 
                onClick={onSmartGenerate} 
                disabled={isGenerating}
                className={`generate-btn-small ${isGenerating ? 'loading' : ''}`}
                style={{ marginLeft: '4px', cursor: isGenerating ? 'not-allowed' : 'pointer' }}
              >
                {isGenerating ? "Menganalisis..." : "Generate Design"}
              </button>
            </div>
          )}

          <button 
            onClick={() => fileInputRef.current?.click()} 
            className="regenerate-cable-btn"
            style={{ marginLeft: '8px', cursor: 'pointer' }}
          >
            <Upload size={14} style={{ marginRight: '6px' }} />
            Import KML
          </button>

          <div style={{ marginLeft: '8px', paddingLeft: '16px', borderLeft: '1px solid rgba(128,128,128,0.2)' }}>
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* Floating Info FAB */}
      <div className="floating-info-container">
        {showInfo && (
          <div className="info-popup">
            <div className="info-popup-header">
              <h3>Information</h3>
              <button className="close-btn" onClick={() => setShowInfo(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="legend-list">
              {legendItems.map((item, idx) => (
                <div key={idx} className="legend-item">
                  <div className="legend-shape">
                    {item.shape === "circle" && <div style={{ width: 12, height: 12, borderRadius: "50%", background: item.color }} />}
                    {item.shape === "square" && <div style={{ width: 12, height: 12, background: item.color }} />}
                    {item.shape === "server" && <Server size={16} color={item.color} fill={item.color} strokeWidth={2} />}
                    {item.shape === "triangle" && <Triangle size={16} color={item.color} fill={item.color} strokeWidth={2} />}
                    {item.shape === "house" && <Home size={16} color={item.color} />}
                    {item.shape === "line" && <div style={{ width: 16, height: 3, background: item.color }} />}
                  </div>
                  <div className="legend-text-group">
                    <span className="legend-label">{item.label}</span>
                    <span className="legend-desc">{item.desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <button 
          className={`info-fab ${showInfo ? 'active' : ''}`}
          onClick={() => setShowInfo(!showInfo)}
        >
          <Info size={24} />
        </button>
      </div>
    </>
  );
}
