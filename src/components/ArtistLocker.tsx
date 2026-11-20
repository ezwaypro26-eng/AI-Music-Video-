import React, { useRef, useState } from "react";
import {
  Camera,
  Check,
  Clapperboard,
  ImagePlus,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import type { Character } from "../types/studio";

interface ArtistLockerProps {
  characters: Character[];
  loading: boolean;
  falConfigured: boolean;
  composerOpen: boolean;
  onToggleComposer: (open: boolean) => void;
  onCharacterCreated: (character: Character) => void;
  onCharacterDeleted: (id: string) => void;
  onCastInStudio: (character: Character) => void;
}

const PROMPT_PRESETS = [
  "Warm tungsten rim light, velvet stage jacket",
  "35mm Kodak Portra grain, moody backstage shadow",
  "Rain-soaked rooftop reflection, dramatic side key",
  "Monochrome editorial spotlight, sharp jawline shadow",
];

export const ArtistLocker: React.FC<ArtistLockerProps> = ({
  characters,
  loading,
  falConfigured,
  composerOpen,
  onToggleComposer,
  onCharacterCreated,
  onCharacterDeleted,
  onCastInStudio,
}) => {
  const [mode, setMode] = useState<"generate" | "upload">("generate");
  const [name, setName] = useState("");
  const [visualPrompt, setVisualPrompt] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFilePicked = (file: File | null) => {
    setError(null);
    if (!file) {
      setSelectedFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("Please select a JPEG, PNG, or WebP portrait image.");
      return;
    }
    setSelectedFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setPreviewUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const appendPreset = (phrase: string) => {
    setVisualPrompt((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return phrase;
      if (trimmed.toLowerCase().includes(phrase.toLowerCase())) return trimmed;
      return `${trimmed}, ${phrase}`;
    });
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !visualPrompt.trim()) {
      setError("Enter both an artist name and a portrait description.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/characters/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          visualPrompt: visualPrompt.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Portrait generation failed.");
      }
      onCharacterCreated(data.character);
      setName("");
      setVisualPrompt("");
      onToggleComposer(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Portrait generation failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Enter an artist name.");
      return;
    }
    if (!selectedFile) {
      setError("Choose a reference portrait photo to upload.");
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("name", name.trim());
      formData.append("visualPrompt", visualPrompt.trim());
      formData.append("photo", selectedFile);

      const res = await fetch("/api/characters/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Photo upload failed.");
      }
      onCharacterCreated(data.character);
      setName("");
      setVisualPrompt("");
      setSelectedFile(null);
      setPreviewUrl(null);
      onToggleComposer(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/characters/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete artist.");
      }
      onCharacterDeleted(id);
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete artist.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Studio Section Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-zinc-800/80 pb-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-50 text-balance">
            Artist Locker
          </h1>
          <p className="text-sm sm:text-base text-zinc-400 max-w-2xl">
            Build your cast of vocalists and performers. Upload a reference photo from your iPad or generate a portrait with Flux Pro 1.1.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onToggleComposer(!composerOpen)}
          className="min-h-[44px] px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-100 border border-zinc-700/80"
        >
          {composerOpen ? "Close Studio Form" : "Add Artist"}
        </button>
      </div>

      {/* Creation Panel */}
      {composerOpen && (
        <section className="rounded-2xl bg-[#111114] border border-zinc-800/90 p-5 sm:p-7 space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">
                Create Artist Profile
              </h2>
              <p className="text-sm text-zinc-400 mt-0.5">
                Saved directly to local SQLite and <span className="font-mono text-zinc-300">public/characters/</span>
              </p>
            </div>

            {/* Interactive Segmented Mode Switch */}
            <div className="inline-flex p-1 rounded-xl bg-zinc-950 border border-zinc-800 self-start">
              <button
                type="button"
                onClick={() => {
                  setMode("generate");
                  setError(null);
                }}
                className={`min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-2 ${
                  mode === "generate"
                    ? "bg-amber-500 text-zinc-950 font-semibold"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Sparkles className="w-4 h-4 shrink-0" />
                <span>Generate Portrait</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("upload");
                  setError(null);
                }}
                className={`min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-2 ${
                  mode === "upload"
                    ? "bg-amber-500 text-zinc-950 font-semibold"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Upload className="w-4 h-4 shrink-0" />
                <span>Upload Photo</span>
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-xl bg-red-950/50 border border-red-800/70 px-4 py-3 text-sm text-red-200"
            >
              {error}
            </div>
          )}

          {mode === "generate" && !falConfigured && (
            <div className="rounded-xl bg-amber-950/30 border border-amber-800/50 px-4 py-3 text-sm text-amber-200/90">
              <span className="font-semibold">FAL_KEY not detected:</span> Add <span className="font-mono">FAL_KEY</span> to your environment secrets to run <span className="font-mono">fal-ai/flux-pro/v1.1</span>, or switch to Upload Photo.
            </div>
          )}

          <form onSubmit={mode === "generate" ? handleGenerate : handleUpload} className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 space-y-5">
              <div className="space-y-2">
                <label htmlFor="artist-name" className="block text-sm font-medium text-zinc-200">
                  Artist Name
                </label>
                <input
                  id="artist-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Mara Vance"
                  className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500 transition-colors text-base"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="visual-prompt" className="block text-sm font-medium text-zinc-200">
                  {mode === "generate" ? "Visual Portrait Description" : "Visual Style Notes (used for scene consistency)"}
                </label>
                <textarea
                  id="visual-prompt"
                  rows={4}
                  value={visualPrompt}
                  onChange={(e) => setVisualPrompt(e.target.value)}
                  placeholder="Describe hair, facial features, wardrobe, lighting, and camera mood..."
                  className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500 transition-colors text-base resize-y"
                />
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-medium text-zinc-400">
                  Quick Visual Modifiers
                </span>
                <div className="flex flex-wrap gap-2">
                  {PROMPT_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => appendPreset(preset)}
                      className="min-h-[40px] px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-medium text-zinc-300 transition-colors text-left"
                    >
                      + {preset}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="lg:col-span-5 flex flex-col justify-between gap-5">
              {mode === "upload" ? (
                <div className="space-y-2 flex-1 flex flex-col">
                  <span className="block text-sm font-medium text-zinc-200">
                    Reference Portrait Photo
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handleFilePicked(e.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleFilePicked(e.dataTransfer.files?.[0] || null);
                    }}
                    className="flex-1 min-h-[220px] rounded-2xl border border-dashed border-zinc-700 hover:border-amber-500/70 bg-zinc-950/80 flex flex-col items-center justify-center p-4 transition-colors overflow-hidden relative"
                  >
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt="Reference preview"
                        className="w-full h-56 object-cover rounded-xl"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-3 text-center">
                        <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300">
                          <Camera className="w-6 h-6" />
                        </div>
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-zinc-200">
                            Tap to select from iPad Photos or Files
                          </p>
                          <p className="text-xs text-zinc-500">
                            JPG, PNG, or WebP up to 20 MB
                          </p>
                        </div>
                      </div>
                    )}
                  </button>
                </div>
              ) : (
                <div className="flex-1 min-h-[220px] rounded-2xl bg-zinc-950 border border-zinc-800/90 p-5 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-zinc-300 text-sm font-medium">
                      <ImagePlus className="w-4 h-4 text-amber-400" />
                      <span>Flux Pro 1.1 Studio Pipeline</span>
                    </div>
                    <p className="text-sm text-zinc-400 leading-relaxed">
                      Generates a 3:4 editorial singer portrait via <span className="font-mono text-zinc-300">@fal-ai/client</span> and saves the image directly into <span className="font-mono text-zinc-300">public/characters/</span> for reuse across scenes.
                    </p>
                  </div>
                  <div className="pt-4 border-t border-zinc-800/80 text-xs text-zinc-500 flex items-center justify-between font-mono">
                    <span>Model: fal-ai/flux-pro/v1.1</span>
                    <span>3:4 Portrait</span>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[52px] px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 font-semibold text-base transition-colors flex items-center justify-center gap-2.5"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>{mode === "generate" ? "Generating Portrait..." : "Saving Portrait..."}</span>
                  </>
                ) : (
                  <>
                    {mode === "generate" ? <Sparkles className="w-5 h-5" /> : <Check className="w-5 h-5" />}
                    <span>{mode === "generate" ? "Generate Singer Portrait" : "Save Reference Photo"}</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Saved Characters Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="rounded-2xl bg-[#111114] border border-zinc-800/80 overflow-hidden">
              <div className="aspect-[3/4] bg-zinc-900 animate-pulse" />
              <div className="p-4 space-y-3">
                <div className="h-5 w-1/2 bg-zinc-800 rounded animate-pulse" />
                <div className="h-4 w-full bg-zinc-900 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : characters.length === 0 ? (
        <div className="rounded-2xl bg-[#111114] border border-zinc-800/80 p-10 sm:p-14 text-center flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400">
            <UserRound className="w-7 h-7" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-semibold text-zinc-100">No artists in your locker yet</h2>
            <p className="text-sm text-zinc-400">
              Upload a reference photo or generate a singer portrait via Flux Pro 1.1 to start casting music video scenes.
            </p>
          </div>
          {!composerOpen && (
            <button
              type="button"
              onClick={() => onToggleComposer(true)}
              className="min-h-[48px] px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-sm transition-colors"
            >
              Create First Artist
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {characters.map((char) => {
            const projectCount = char._count?.projects ?? 0;
            const isBroken = brokenImages[char.id];

            return (
              <article
                key={char.id}
                className="rounded-2xl bg-[#111114] border border-zinc-800/90 overflow-hidden flex flex-col justify-between"
              >
                <div>
                  <div className="aspect-[3/4] bg-zinc-950 relative overflow-hidden">
                    {!isBroken ? (
                      <img
                        src={char.refImagePath}
                        alt={`${char.name} portrait`}
                        referrerPolicy="no-referrer"
                        onError={() => setBrokenImages((prev) => ({ ...prev, [char.id]: true }))}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-gradient-to-b from-zinc-900 to-zinc-950 text-zinc-500 p-4 text-center">
                        <UserRound className="w-10 h-10" />
                        <span className="text-xs font-medium">{char.name}</span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/85 via-black/40 to-transparent pointer-events-none" />
                    <div className="absolute inset-x-0 bottom-0 p-4">
                      <h3 className="text-lg font-semibold text-white truncate">
                        {char.name}
                      </h3>
                      <p className="text-xs text-zinc-300 mt-0.5 tabular-nums">
                        {projectCount === 0
                          ? "Ready for casting"
                          : `${projectCount} ${projectCount === 1 ? "project" : "projects"}`}
                        <span aria-hidden="true"> · </span>
                        <span className="font-mono">Saved</span>
                      </p>
                    </div>
                  </div>

                  <div className="p-4">
                    <p className="text-sm text-zinc-400 line-clamp-2 leading-relaxed">
                      {char.visualPrompt}
                    </p>
                  </div>
                </div>

                <div className="px-4 pb-4 pt-2 border-t border-zinc-800/70 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onCastInStudio(char)}
                    className="flex-1 min-h-[44px] px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-sm font-medium text-zinc-100 transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <Clapperboard className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Cast in Studio</span>
                  </button>

                  {confirmDeleteId === char.id ? (
                    <button
                      type="button"
                      disabled={deletingId === char.id}
                      onClick={() => handleDelete(char.id)}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors whitespace-nowrap"
                    >
                      {deletingId === char.id ? "..." : "Confirm"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${char.name}`}
                      onClick={() => setConfirmDeleteId(char.id)}
                      className="min-h-[44px] min-w-[44px] rounded-xl bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-red-400 transition-colors flex items-center justify-center shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
