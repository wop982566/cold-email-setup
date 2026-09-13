import { ReactNode, useState } from "react";
import { Lock } from "lucide-react";
import { authEnabled, isAuthed, signIn } from "../lib/auth";

export function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(isAuthed());
  if (!authEnabled || authed) return <>{children}</>;
  return <LoginScreen onSuccess={() => setAuthed(true)} />;
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (signIn(username, password)) onSuccess();
    else setError(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="card w-full max-w-sm p-6 shadow-hard-lg">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border-2 border-ink bg-pink shadow-hard-sm">
            <Lock size={18} />
          </span>
          <div className="leading-none">
            <p className="text-sm font-extrabold">Cold Email</p>
            <p className="text-sm font-extrabold text-pink-dark">Command Center</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <span className="label">Username</span>
            <input
              className="input"
              value={username}
              autoFocus
              onChange={(e) => {
                setUsername(e.target.value);
                setError(false);
              }}
            />
          </div>
          <div>
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(false);
              }}
            />
          </div>
          {error ? (
            <p className="rounded-lg border-2 border-ink bg-danger px-3 py-1.5 text-sm font-bold text-white">
              Wrong username or password.
            </p>
          ) : null}
          <button type="submit" className="btn-primary w-full">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
