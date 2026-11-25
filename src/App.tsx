import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Plus, UserRound } from "lucide-react";
import { ArtistLocker } from "./components/ArtistLocker";
import { MvStudio } from "./components/MvStudio";
import type { Capabilities, Character, Project } from "./types/studio";

type StudioTab = "locker" | "studio";

export default function App() {
  const [activeTab, setActiveTab] = useState<StudioTab>("locker");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    modalFluxConfigured: true,
    modalWhisperConfigured: true,
    modalDemucsConfigured: true,
    modalLipsyncConfigured: true,
    modalVideoConfigured: true,
    geminiConfigured: true,
    openaiConfigured: true,
    ffmpegAvailable: true,
  });
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false);
  const [loadingCharacters, setLoadingCharacters] = useState(true);
  const [loadingProjects, setLoadingProjects] = useState(true);

  const [lockerComposerOpen, setLockerComposerOpen] = useState(true);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [castCharacterId, setCastCharacterId] = useState<string | null>(null);

  const loadAll = useCallback(async (attempt = 0) => {
    try {
      const [charRes, projRes, capRes] = await Promise.all([
        fetch("/api/characters"),
        fetch("/api/projects"),
        fetch("/api/capabilities"),
      ]);

      if (charRes.ok) {
        const charData = await charRes.json();
        const list: Character[] = charData.characters || [];
        setCharacters(list);
        if (list.length > 0) {
          setLockerComposerOpen(false);
        }
      }
      if (projRes.ok) {
        const projData = await projRes.json();
        const list: Project[] = projData.projects || [];
        setProjects(list);
        if (list.length > 0) {
          setActiveProjectId((prev) => prev || list[0].id);
        } else {
          setNewProjectOpen(true);
        }
      }
      if (capRes.ok) {
        const capData = await capRes.json();
        setCapabilities(capData);
        setCapabilitiesLoaded(true);
      } else if (attempt < 5) {
        window.setTimeout(() => void loadAll(attempt + 1), 1500);
      }
    } catch (err) {
      console.error("Initial load error:", err);
      if (attempt < 5) {
        window.setTimeout(() => void loadAll(attempt + 1), 1500);
      }
    } finally {
      setLoadingCharacters(false);
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadAll(0);
  }, [loadAll]);

  const handleCharacterCreated = (character: Character) => {
    setCharacters((prev) => [character, ...prev]);
  };

  const handleCharacterDeleted = (id: string) => {
    setCharacters((prev) => prev.filter((c) => c.id !== id));
    setProjects((prev) =>
      prev.map((p) => ({
        ...p,
        characterId: p.characterId === id ? null : p.characterId,
        character: p.characterId === id ? null : p.character,
        castMembers: (p.castMembers || []).filter((entry) => entry.artistId !== id),
      }))
    );
  };

  const handleCastInStudio = (character: Character) => {
    setCastCharacterId(character.id);
    setActiveTab("studio");
    if (projects.length === 0) {
      setNewProjectOpen(true);
    }
  };

  const handleProjectCreated = (project: Project) => {
    setProjects((prev) => [project, ...prev]);
    setActiveProjectId(project.id);
  };

  const handleProjectUpdated = (updated: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  };

  const handleProjectDeleted = (id: string) => {
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id);
      setActiveProjectId(next[0]?.id || null);
      return next;
    });
  };

  const handleTopAction = () => {
    if (activeTab === "locker") {
      setLockerComposerOpen(true);
    } else {
      setNewProjectOpen(true);
    }
  };

  return (
    <div className="min-h-screen bg-[#09090B] text-zinc-100 flex flex-col">
      {/* 3-Zone Top Bar */}
      <header className="sticky top-0 z-30 bg-[#09090B]/90 backdrop-blur-md border-b border-zinc-800/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <span className="font-display text-lg font-bold tracking-tight text-zinc-50 whitespace-nowrap shrink-0">
            Nocturne Studio
          </span>

          {/* Zone 2: Desktop/iPad Tab Navigation */}
          <nav aria-label="Studio sections" className="hidden sm:flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("locker")}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 ${
                activeTab === "locker"
                  ? "bg-zinc-900 text-zinc-50 border border-zinc-700/80"
                  : "text-zinc-400 hover:text-zinc-100"
              }`}
            >
              <UserRound className="w-4 h-4 shrink-0" />
              <span>Artist Locker</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("studio")}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 ${
                activeTab === "studio"
                  ? "bg-zinc-900 text-zinc-50 border border-zinc-700/80"
                  : "text-zinc-400 hover:text-zinc-100"
              }`}
            >
              <Clapperboard className="w-4 h-4 shrink-0" />
              <span>MV Studio</span>
            </button>
          </nav>

          {/* Zone 3: Single Primary Contextual Action */}
          <button
            type="button"
            onClick={handleTopAction}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>{activeTab === "locker" ? "New Artist" : "New Project"}</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-24 sm:pb-12">
        {activeTab === "locker" ? (
          <ArtistLocker
            characters={characters}
            loading={loadingCharacters}
            fluxConfigured={capabilitiesLoaded ? capabilities.modalFluxConfigured : true}
            composerOpen={lockerComposerOpen}
            onToggleComposer={setLockerComposerOpen}
            onCharacterCreated={handleCharacterCreated}
            onCharacterDeleted={handleCharacterDeleted}
            onCastInStudio={handleCastInStudio}
          />
        ) : (
          <MvStudio
            projects={projects}
            characters={characters}
            loading={loadingProjects}
            audioModelsConfigured={capabilitiesLoaded ? capabilities.modalWhisperConfigured && capabilities.modalDemucsConfigured : true}
            geminiConfigured={capabilitiesLoaded ? capabilities.geminiConfigured : true}
            openaiConfigured={capabilitiesLoaded ? capabilities.openaiConfigured : true}
            activeProjectId={activeProjectId}
            newProjectOpen={newProjectOpen}
            preselectedCharacterId={castCharacterId}
            onSelectProject={setActiveProjectId}
            onToggleNewProject={setNewProjectOpen}
            onProjectCreated={handleProjectCreated}
            onProjectUpdated={handleProjectUpdated}
            onProjectDeleted={handleProjectDeleted}
          />
        )}
      </main>

      {/* Mobile / Portrait-iPad Fixed Bottom Tab Bar */}
      <nav
        aria-label="Mobile studio tabs"
        className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#09090B]/95 backdrop-blur-md border-t border-zinc-800/90"
      >
        <div className="grid grid-cols-2 h-16">
          <button
            type="button"
            onClick={() => setActiveTab("locker")}
            className={`flex flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
              activeTab === "locker" ? "text-amber-400" : "text-zinc-400"
            }`}
          >
            <UserRound className="w-5 h-5" />
            <span>Artist Locker</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("studio")}
            className={`flex flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
              activeTab === "studio" ? "text-amber-400" : "text-zinc-400"
            }`}
          >
            <Clapperboard className="w-5 h-5" />
            <span>MV Studio</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
