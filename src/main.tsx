import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class StudioErrorBoundary extends React.Component<
  {children: React.ReactNode},
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {hasError: false, message: ''};

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: err?.message || 'Unexpected studio rendering error.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#09090B] text-zinc-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl bg-[#111114] border border-zinc-800 p-6 space-y-4">
            <h1 className="text-lg font-semibold text-zinc-50">
              Nocturne Studio Recovery
            </h1>
            <p className="text-sm text-zinc-400">{this.state.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-[44px] px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 text-sm font-semibold transition-colors"
            >
              Reload Studio
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StudioErrorBoundary>
    <App />
  </StudioErrorBoundary>,
);
