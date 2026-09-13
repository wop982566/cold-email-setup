import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "../../lib/utils";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  push: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (message: string, kind: ToastKind = "success") => {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t, { id, kind, message }]);
      setTimeout(() => remove(id), 4000);
    },
    [remove],
  );

  const tone = {
    success: "bg-mint text-white",
    error: "bg-danger text-white",
    info: "bg-sky",
  };
  const Icon = { success: CheckCircle2, error: AlertTriangle, info: Info };

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((t) => {
          const I = Icon[t.kind];
          return (
            <div
              key={t.id}
              className={cn(
                "card flex animate-fade-in items-center gap-3 p-3 shadow-hard",
                tone[t.kind],
              )}
            >
              <I size={18} className="shrink-0" />
              <p className="flex-1 text-sm font-semibold">{t.message}</p>
              <button onClick={() => remove(t.id)}>
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
