import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { Top } from "./components/Top.tsx";
import { AboutPage } from "./pages/About.tsx";
import { EvidencePage } from "./pages/Evidence.tsx";
import { HomePage } from "./pages/Home.tsx";
import { HouseholdPage } from "./pages/Household.tsx";
import { JoinPage } from "./pages/Join.tsx";
import { MemberPage } from "./pages/Member.tsx";
import { SharePage } from "./pages/Share.tsx";
import { StatementPage } from "./pages/Statement.tsx";

// the scheduler is a large bundle: only the coordinator's page loads it, so the phones stay light
const BoardPage = lazy(() => import("./pages/Board.tsx").then((m) => ({ default: m.BoardPage })));

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="*" element={<WithTop />} />
      </Routes>
    </BrowserRouter>
  );
}

function WithTop() {
  return (
    <>
      <Top />
      <main id="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/board"
            element={
              <Suspense fallback={<p className="page">Loading the board…</p>}>
                <BoardPage />
              </Suspense>
            }
          />
          <Route path="/m/:id" element={<MemberPage />} />
          <Route path="/m/:id/statement" element={<StatementPage />} />
          <Route path="/h/:id" element={<HouseholdPage />} />
          <Route path="/join" element={<JoinPage />} />
          <Route path="/evidence/:id" element={<EvidencePage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
