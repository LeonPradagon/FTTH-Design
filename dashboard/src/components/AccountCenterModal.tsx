import React, { useState, useEffect } from 'react';
import { X, Key, ShieldAlert, LogOut, Copy, RefreshCw, AlertTriangle, UserPlus, Trash2 } from 'lucide-react';
import { authClient, changePassword, deleteUser, signOut } from '@/lib/auth-client';
import { useRouter } from 'next/navigation';

interface AccountCenterModalProps {
  onClose: () => void;
  userEmail: string;
  userRole: string;
}

export function AccountCenterModal({ onClose, userEmail, userRole }: AccountCenterModalProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'password' | 'users' | 'danger'>('password');
  
  // Users Management state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [users, setUsers] = useState<any[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [isAddingUser, setIsAddingUser] = useState(false);
  
  // Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  // Danger state
  const [deleteEmail, setDeleteEmail] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Create state
  const [createName, setCreateName] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState<'user' | 'admin'>('user');
  const [isCreating, setIsCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  const fetchUsers = async () => {
    setIsLoadingUsers(true);
    try {
      const { data } = await authClient.admin.listUsers({ query: { limit: 100 } });
      if (data && data.users) setUsers(data.users);
    } catch (err: unknown) {
      console.error(err);
    } finally {
      setIsLoadingUsers(false);
    }
  };

  // Fetch users if user is admin and tab is users
  useEffect(() => {
    const load = async () => {
      if (activeTab === 'users' && userRole === 'admin') {
        await fetchUsers();
      }
    };
    load();
  }, [activeTab, userRole]);



  const handleRemoveUser = async (userId: string) => {
    if (!confirm('Apakah Anda yakin ingin menghapus pengguna ini secara permanen?')) return;
    try {
      const { error } = await authClient.admin.removeUser({ userId });
      if (error) {
        alert('Gagal menghapus pengguna: ' + error.message);
      } else {
        setUsers(users.filter(u => u.id !== userId));
      }
    } catch {
      alert('Terjadi kesalahan saat menghapus.');
    }
  };

  const handleGeneratePassword = () => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let password = "";
    for (let i = 0; i < 16; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setGeneratedPassword(password);
    setNewPassword(password);
    setPasswordMessage(null);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedPassword);
    setPasswordMessage({ type: 'success', text: 'Password disalin ke clipboard!' });
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      setPasswordMessage({ type: 'error', text: 'Semua kolom wajib diisi.' });
      return;
    }
    
    setIsChangingPassword(true);
    setPasswordMessage(null);
    try {
      const { error } = await changePassword({
        newPassword: newPassword,
        currentPassword: currentPassword,
        revokeOtherSessions: true,
      });
      
      if (error) {
        setPasswordMessage({ type: 'error', text: error.message || 'Gagal mengubah password' });
      } else {
        setPasswordMessage({ type: 'success', text: 'Password berhasil diubah!' });
        setCurrentPassword('');
        setNewPassword('');
        setGeneratedPassword('');
      }
    } catch (err: unknown) {
      setPasswordMessage({ type: 'error', text: (err as Error).message || 'Terjadi kesalahan sistem' });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (deleteEmail.trim().toLowerCase() !== userEmail.trim().toLowerCase()) {
      setDeleteError('Email tidak cocok.');
      return;
    }
    if (!deletePassword) {
      setDeleteError('Masukkan password saat ini untuk konfirmasi.');
      return;
    }

    setIsDeleting(true);
    setDeleteError('');
    try {
      const { error } = await deleteUser();
      
      if (error) {
        setDeleteError(error.message || 'Gagal menghapus akun');
        setIsDeleting(false);
      } else {
        router.push('/login');
      }
    } catch (err: unknown) {
      setDeleteError((err as Error).message || 'Terjadi kesalahan saat menghapus akun.');
      setIsDeleting(false);
    }
  };

  const handleLogout = async () => {
    await signOut();
    router.push('/login');
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName || !createEmail || !createPassword) {
      setCreateMessage({ type: 'error', text: 'Semua kolom wajib diisi.' });
      return;
    }

    setIsCreating(true);
    setCreateMessage(null);
    try {
      const { error } = await authClient.admin.createUser({
        email: createEmail.trim(),
        password: createPassword,
        name: createName.trim(),
        role: createRole
      });

      if (error) {
        setCreateMessage({ type: 'error', text: error.message || 'Gagal membuat akun' });
      } else {
        setCreateMessage({ type: 'success', text: 'Akun berhasil dibuat!' });
        setCreateName('');
        setCreateEmail('');
        setCreatePassword('');
        setCreateRole('user');
        setIsAddingUser(false);
        fetchUsers();
      }
    } catch (err: unknown) {
      setCreateMessage({ type: 'error', text: (err as Error).message || 'Terjadi kesalahan' });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}>
      <div style={{ background: 'white', borderRadius: '16px', width: '450px', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)' }}>
        
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: '#111827' }}>Account Center</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 0 0' }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#6b7280' }}>{userEmail}</p>
              <span style={{ fontSize: '10px', background: '#e5e7eb', color: '#374151', padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase', fontWeight: 600 }}>{userRole}</span>
              <span style={{ fontSize: '10px', background: '#d1fae5', color: '#065f46', padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block' }}></span>
                Aktif
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', color: '#9ca3af' }}>
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 24px' }}>
          <button 
            onClick={() => setActiveTab('password')}
            style={{ 
              padding: '16px 0', marginRight: '24px', background: 'transparent', border: 'none', borderBottom: activeTab === 'password' ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === 'password' ? '#3b82f6' : '#6b7280', fontWeight: 500, fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px'
            }}
          >
            <Key size={16} /> Keamanan
          </button>
          <button 
            onClick={() => setActiveTab('users')}
            style={{ 
              padding: '16px 0', marginRight: '24px', background: 'transparent', border: 'none', borderBottom: activeTab === 'users' ? '2px solid #10b981' : '2px solid transparent',
              color: activeTab === 'users' ? '#10b981' : '#6b7280', fontWeight: 500, fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px'
            }}
          >
            <UserPlus size={16} /> Pengguna
          </button>
          <button 
            onClick={() => setActiveTab('danger')}
            style={{ 
              padding: '16px 0', background: 'transparent', border: 'none', borderBottom: activeTab === 'danger' ? '2px solid #ef4444' : '2px solid transparent',
              color: activeTab === 'danger' ? '#ef4444' : '#6b7280', fontWeight: 500, fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px'
            }}
          >
            <ShieldAlert size={16} /> Danger Zone
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px' }}>
          
          {/* PASSWORD TAB */}
          {activeTab === 'password' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#374151' }}>Ubah Password</h3>
                <button onClick={handleGeneratePassword} style={{ background: '#f3f4f6', border: 'none', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, color: '#4b5563', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <RefreshCw size={12} /> Generate
                </button>
              </div>

              {generatedPassword && (
                <div style={{ background: '#eff6ff', border: '1px dashed #3b82f6', padding: '12px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: '14px', color: '#1e3a8a', letterSpacing: '1px' }}>{generatedPassword}</span>
                  <button onClick={copyToClipboard} style={{ background: 'transparent', border: 'none', color: '#3b82f6', cursor: 'pointer', padding: '4px' }} title="Salin">
                    <Copy size={16} />
                  </button>
                </div>
              )}

              {passwordMessage && (
                <div style={{ padding: '10px 12px', borderRadius: '6px', fontSize: '13px', backgroundColor: passwordMessage.type === 'error' ? '#fef2f2' : '#ecfdf5', color: passwordMessage.type === 'error' ? '#ef4444' : '#10b981', border: `1px solid ${passwordMessage.type === 'error' ? '#fecaca' : '#a7f3d0'}` }}>
                  {passwordMessage.text}
                </div>
              )}

              <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#4b5563', marginBottom: '6px' }}>Password Saat Ini</label>
                  <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#4b5563', marginBottom: '6px' }}>Password Baru</label>
                  <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
                <button type="submit" disabled={isChangingPassword} style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', cursor: isChangingPassword ? 'not-allowed' : 'pointer', opacity: isChangingPassword ? 0.7 : 1, marginTop: '8px' }}>
                  {isChangingPassword ? 'Menyimpan...' : 'Simpan Password'}
                </button>
              </form>
            </div>
          )}

          {/* USERS TAB */}
          {activeTab === 'users' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#374151' }}>Manajemen Pengguna</h3>
                {!isAddingUser && (
                  <button onClick={() => setIsAddingUser(true)} style={{ background: '#10b981', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <UserPlus size={14} /> Tambah
                  </button>
                )}
              </div>

              {createMessage && (
                <div style={{ padding: '10px 12px', borderRadius: '6px', fontSize: '13px', backgroundColor: createMessage.type === 'error' ? '#fef2f2' : '#ecfdf5', color: createMessage.type === 'error' ? '#ef4444' : '#10b981', border: `1px solid ${createMessage.type === 'error' ? '#fecaca' : '#a7f3d0'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  {createMessage.text}
                  <button onClick={() => setCreateMessage(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}><X size={14} color={createMessage.type === 'error' ? '#ef4444' : '#10b981'} /></button>
                </div>
              )}

              {isAddingUser ? (
                <form onSubmit={handleCreateAccount} style={{ display: 'flex', flexDirection: 'column', gap: '16px', background: '#f9fafb', padding: '16px', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#374151' }}>Tambah Akun Baru</h4>
                    <button type="button" onClick={() => setIsAddingUser(false)} style={{ background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer' }}><X size={16} /></button>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#4b5563', marginBottom: '6px' }}>Nama Lengkap</label>
                    <input type="text" value={createName} onChange={e => setCreateName(e.target.value)} required style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#4b5563', marginBottom: '6px' }}>Alamat Email</label>
                    <input type="email" value={createEmail} onChange={e => setCreateEmail(e.target.value)} required style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#4b5563', marginBottom: '6px' }}>Password</label>
                    <input type="password" value={createPassword} onChange={e => setCreatePassword(e.target.value)} required style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#4b5563', marginBottom: '6px' }}>Role</label>
                    <select value={createRole} onChange={e => setCreateRole(e.target.value as 'user' | 'admin')} style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box', backgroundColor: 'white' }}>
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <button type="submit" disabled={isCreating} style={{ background: '#10b981', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', cursor: isCreating ? 'not-allowed' : 'pointer', opacity: isCreating ? 0.7 : 1, marginTop: '8px' }}>
                    {isCreating ? 'Menyimpan...' : 'Buat Akun'}
                  </button>
                </form>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                  {isLoadingUsers ? (
                    <p style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', padding: '20px' }}>Memuat daftar pengguna...</p>
                  ) : users.length === 0 ? (
                    <p style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', padding: '20px' }}>Tidak ada pengguna ditemukan.</p>
                  ) : (
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    users.map((u: any) => (
                      <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', borderRadius: '8px', border: '1px solid #e5e7eb', background: u.email === userEmail ? '#f0fdf4' : 'white' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: '14px', fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {u.name}
                            {u.email === userEmail && <span style={{ fontSize: '10px', background: '#d1fae5', color: '#065f46', padding: '2px 6px', borderRadius: '4px' }}>YOU</span>}
                          </span>
                          <span style={{ fontSize: '12px', color: '#6b7280' }}>{u.email}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span style={{ fontSize: '11px', background: '#f3f4f6', color: '#4b5563', padding: '4px 8px', borderRadius: '4px', textTransform: 'uppercase', fontWeight: 600 }}>{u.role || 'USER'}</span>
                          {u.email !== userEmail && (
                            <button onClick={() => handleRemoveUser(u.id)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }} title="Hapus Pengguna">
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {/* DANGER ZONE TAB */}
          {activeTab === 'danger' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#dc2626' }}>Hapus Akun Anda</h3>
                <p style={{ margin: '8px 0 0 0', fontSize: '13px', color: '#4b5563', lineHeight: 1.5 }}>
                  Bagian ini <strong>hanya</strong> untuk menghapus akun Anda sendiri (<span style={{ fontWeight: 600 }}>{userEmail}</span>). Untuk menghapus pengguna lain, silakan gunakan tab <strong>Pengguna</strong>.
                </p>
              </div>

              <div style={{ background: '#fef2f2', padding: '16px', borderRadius: '8px', border: '1px solid #fecaca' }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600, color: '#b91c1c', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <AlertTriangle size={16} /> Peringatan
                </h3>
                <p style={{ margin: 0, fontSize: '13px', color: '#991b1b', lineHeight: 1.5 }}>
                  Tindakan ini akan <b>menghapus permanen</b> akun Anda beserta seluruh sesi akses yang aktif. Tindakan ini tidak dapat dibatalkan.
                </p>
              </div>

              {deleteError && (
                <div style={{ padding: '10px 12px', borderRadius: '6px', fontSize: '13px', backgroundColor: '#fef2f2', color: '#ef4444', border: '1px solid #fecaca' }}>
                  {deleteError}
                </div>
              )}

              <form onSubmit={handleDeleteAccount} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#4b5563', marginBottom: '6px' }}>Ketik email Anda untuk konfirmasi</label>
                  <input type="email" value={deleteEmail} onChange={e => setDeleteEmail(e.target.value)} required placeholder={userEmail} style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#4b5563', marginBottom: '6px' }}>Password Saat Ini</label>
                  <input type="password" value={deletePassword} onChange={e => setDeletePassword(e.target.value)} required style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
                <button type="submit" disabled={isDeleting} style={{ background: '#ef4444', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', cursor: isDeleting ? 'not-allowed' : 'pointer', opacity: isDeleting ? 0.7 : 1, marginTop: '8px' }}>
                  {isDeleting ? 'Menghapus...' : 'Ya, Hapus Akun Saya'}
                </button>
              </form>
            </div>
          )}

        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', background: '#f9fafb', borderTop: '1px solid #e5e7eb' }}>
          <button 
            onClick={handleLogout}
            style={{ width: '100%', background: 'white', border: '1px solid #d1d5db', color: '#374151', padding: '12px', borderRadius: '8px', fontSize: '14px', fontWeight: 600, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', cursor: 'pointer', transition: 'background 0.2s' }}
            onMouseEnter={e => e.currentTarget.style.background = '#f3f4f6'}
            onMouseLeave={e => e.currentTarget.style.background = 'white'}
          >
            <LogOut size={16} /> Keluar dari Aplikasi
          </button>
        </div>

      </div>
    </div>
  );
}
