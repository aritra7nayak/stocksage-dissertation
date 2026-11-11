import { Component, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/* Without this, one throw anywhere in a page unmounts the entire tree and the
   user gets a blank screen with the reason only in the devtools console. */
export default class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { children: ReactNode; resetKey?: string }) {
    // Navigating away from the broken page clears the error.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("Page crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="glass mx-auto mt-20 max-w-lg rounded-2xl p-8">
        <AlertTriangle size={28} className="mb-3 text-sell" />
        <h2 className="font-display text-xl font-bold">This page hit an error</h2>
        <p className="mt-2 text-sm text-muted">
          The rest of the app still works — switch pages, or reload to try again.
        </p>
        <pre className="num mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-[11px] text-sell"
          style={{ background: "rgb(240 82 107 / 0.08)" }}>
          {error.message}
        </pre>
        <button onClick={() => this.setState({ error: null })}
          className="mt-4 rounded-lg border px-4 py-2 text-sm transition hover:scale-105"
          style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
          Try again
        </button>
      </div>
    );
  }
}
