"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn, signUp, useSession } from "@/lib/auth-client";

function FiberMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 40 40" fill="none" className="size-7">
      <path
        d="M9 29 20 20 31 9M20 20l11 11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className="text-white/80"
      />
      {["9,29", "20,20", "31,9", "31,31"].map((point) => {
        const [cx, cy] = point.split(",");
        return (
          <circle
            key={point}
            cx={cx}
            cy={cy}
            r="3"
            className="fill-white stroke-blue-600"
            strokeWidth="1.5"
          />
        );
      })}
    </svg>
  );
}

function RouteBackdrop() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1440 900"
      preserveAspectRatio="none"
      className="pointer-events-none fixed inset-0 h-full w-full text-blue-100/70"
    >
      <path d="M-80 110 230 245 425 135" stroke="currentColor" strokeWidth="1" fill="none" />
      <path d="m1080 760 190-150 250 95" stroke="currentColor" strokeWidth="1" fill="none" />
      <g className="fill-white stroke-blue-200" strokeWidth="2">
        <circle cx="230" cy="245" r="5" />
        <circle cx="425" cy="135" r="5" />
        <circle cx="1080" cy="760" r="5" />
        <circle cx="1270" cy="610" r="5" />
      </g>
    </svg>
  );
}

export default function LoginPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (!isPending && session) {
      router.replace("/");
    }
  }, [isPending, router, session]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (isLogin) {
        const { error: signInError } = await signIn.email({ email, password });
        if (signInError) throw new Error(signInError.message);
      } else {
        const { error: signUpError } = await signUp.email({ email, password, name });
        if (signUpError) throw new Error(signUpError.message);
      }

      router.push("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Terjadi kesalahan");
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setIsLogin((currentMode) => !currentMode);
    setError("");
    setShowPassword(false);
  };

  const lightInputClasses =
    "h-11 border-slate-300 bg-white text-slate-900 shadow-xs placeholder:text-slate-400 focus-visible:border-blue-600 focus-visible:ring-blue-600/15 dark:border-slate-300 dark:bg-white dark:text-slate-900 dark:placeholder:text-slate-400";

  return (
    <main className="relative grid h-svh place-items-center overflow-y-auto bg-white px-4 py-10 text-slate-900 [color-scheme:light] sm:px-6">
      <RouteBackdrop />

      <Card className="relative z-10 w-full max-w-[460px] gap-0 rounded-2xl border-slate-200 bg-white py-0 text-slate-900 shadow-[0_24px_70px_rgba(28,51,84,0.10),0_2px_8px_rgba(28,51,84,0.04)] dark:border-slate-200 dark:bg-white dark:text-slate-900">
        <CardHeader className="px-6 pt-7 pb-0 sm:px-10 sm:pt-9">
          <div className="mb-8 flex items-center gap-2.5 text-sm font-bold tracking-tight text-slate-900">
            <span className="grid size-9 place-items-center rounded-xl bg-blue-600 text-white shadow-md shadow-blue-600/20">
              <FiberMark />
            </span>
            <span>FTTH Design</span>
          </div>

          <p className="mb-2 text-[11px] font-bold tracking-[0.12em] text-blue-600 uppercase">
            Platform perencanaan jaringan
          </p>
          <CardTitle id="auth-title" className="text-[28px] leading-tight font-bold tracking-[-0.035em] text-slate-950 sm:text-[32px]">
            {isLogin ? "Selamat datang kembali" : "Buat akun Anda"}
          </CardTitle>
        </CardHeader>

        <CardContent className="px-6 pt-7 sm:px-10">
          {error && (
            <Alert className="mb-5 border-red-200 bg-red-50 text-red-700 dark:border-red-200 dark:bg-red-50 dark:text-red-700" role="alert">
              <AlertCircle className="text-red-600" />
              <AlertDescription className="text-red-700">{error}</AlertDescription>
            </Alert>
          )}

          <form className="grid gap-5" onSubmit={handleSubmit}>
            {!isLogin && (
              <div className="grid gap-2">
                <Label htmlFor="name" className="text-[13px] font-semibold text-slate-700 dark:text-slate-700">
                  Nama lengkap
                </Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required={!isLogin}
                  autoComplete="name"
                  placeholder="Masukkan nama lengkap"
                  className={lightInputClasses}
                />
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="email" className="text-[13px] font-semibold text-slate-700 dark:text-slate-700">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
                inputMode="email"
                placeholder="admin@example.com"
                className={lightInputClasses}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password" className="text-[13px] font-semibold text-slate-700 dark:text-slate-700">
                Password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={8}
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  placeholder="Minimal 8 karakter"
                  className={`${lightInputClasses} pr-11`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowPassword((isVisible) => !isVisible)}
                  aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}
                  aria-pressed={showPassword}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-100 dark:hover:text-slate-700"
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-1 h-11 w-full bg-blue-600 font-bold text-white shadow-md shadow-blue-600/20 hover:bg-blue-700 dark:bg-blue-600 dark:text-white dark:hover:bg-blue-700"
            >
              {loading && <LoaderCircle className="animate-spin" />}
              {loading ? "Memproses..." : isLogin ? "Masuk" : "Buat akun"}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="justify-center border-0 bg-white !p-0 text-[13px] text-slate-500 dark:bg-white">
          <div className="w-full px-6 pt-6 pb-8 text-center sm:px-10">
            {isLogin ? "Belum punya akun? " : "Sudah punya akun? "}
            <Button
              type="button"
              variant="link"
              onClick={toggleMode}
              className="h-auto px-1 text-[13px] font-bold text-blue-600 hover:text-blue-700 dark:text-blue-600 dark:hover:text-blue-700"
            >
              {isLogin ? "Daftar sekarang" : "Masuk di sini"}
            </Button>
          </div>
        </CardFooter>
      </Card>

    </main>
  );
}
