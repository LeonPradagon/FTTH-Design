"use client";

import { useState } from "react";
import { signIn, signUp } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (isLogin) {
        const { data, error } = await signIn.email({
          email,
          password,
        });
        if (error) throw new Error(error.message);
        router.push("/");
      } else {
        const { data, error } = await signUp.email({
          email,
          password,
          name,
        });
        if (error) throw new Error(error.message);
        router.push("/");
      }
    } catch (err: any) {
      setError(err.message || "Terjadi kesalahan");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#f3f4f6" }}>
      <div style={{ backgroundColor: "white", padding: "40px", borderRadius: "12px", width: "100%", maxWidth: "400px", boxShadow: "0 10px 25px rgba(0,0,0,0.1)" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 700, textAlign: "center", marginBottom: "24px", color: "#111827" }}>
          {isLogin ? "Masuk ke FTTH Design" : "Daftar Akun Baru"}
        </h1>
        
        {error && (
          <div style={{ backgroundColor: "#fee2e2", color: "#ef4444", padding: "12px", borderRadius: "8px", marginBottom: "20px", fontSize: "14px" }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {!isLogin && (
            <div>
              <label style={{ display: "block", fontSize: "14px", fontWeight: 500, marginBottom: "8px", color: "#374151" }}>Nama Lengkap</label>
              <input 
                type="text" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                required={!isLogin}
                style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #d1d5db" }}
                placeholder="John Doe"
              />
            </div>
          )}
          
          <div>
            <label style={{ display: "block", fontSize: "14px", fontWeight: 500, marginBottom: "8px", color: "#374151" }}>Email</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #d1d5db" }}
              placeholder="admin@example.com"
            />
          </div>
          
          <div>
            <label style={{ display: "block", fontSize: "14px", fontWeight: 500, marginBottom: "8px", color: "#374151" }}>Password</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #d1d5db" }}
              placeholder="••••••••"
            />
          </div>

          <button 
            type="submit" 
            disabled={loading}
            style={{ width: "100%", padding: "12px", backgroundColor: "#3b82f6", color: "white", border: "none", borderRadius: "6px", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", marginTop: "8px", opacity: loading ? 0.7 : 1 }}
          >
            {loading ? "Memproses..." : (isLogin ? "Masuk" : "Daftar")}
          </button>
        </form>

        <div style={{ marginTop: "24px", textAlign: "center", fontSize: "14px", color: "#6b7280" }}>
          {isLogin ? "Belum punya akun? " : "Sudah punya akun? "}
          <button 
            onClick={() => setIsLogin(!isLogin)}
            style={{ background: "none", border: "none", color: "#3b82f6", fontWeight: 600, cursor: "pointer", padding: 0 }}
          >
            {isLogin ? "Daftar di sini" : "Masuk di sini"}
          </button>
        </div>
      </div>
    </div>
  );
}
