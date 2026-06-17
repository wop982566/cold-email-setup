import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/layout/Layout";
import { Spinner } from "./components/ui/primitives";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Domains = lazy(() => import("./pages/Domains"));
const Capacity = lazy(() => import("./pages/Capacity"));
const Leads = lazy(() => import("./pages/Leads"));
const Sequences = lazy(() => import("./pages/Sequences"));
const Instantly = lazy(() => import("./pages/Instantly"));
const Costs = lazy(() => import("./pages/Costs"));
const Setups = lazy(() => import("./pages/Setups"));
const Insights = lazy(() => import("./pages/Insights"));
const Settings = lazy(() => import("./pages/Settings"));

function Loading() {
  return (
    <div className="flex justify-center p-12">
      <Spinner />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          index
          element={
            <Suspense fallback={<Loading />}>
              <Dashboard />
            </Suspense>
          }
        />
        <Route
          path="/domains"
          element={
            <Suspense fallback={<Loading />}>
              <Domains />
            </Suspense>
          }
        />
        <Route
          path="/capacity"
          element={
            <Suspense fallback={<Loading />}>
              <Capacity />
            </Suspense>
          }
        />
        <Route
          path="/leads"
          element={
            <Suspense fallback={<Loading />}>
              <Leads />
            </Suspense>
          }
        />
        <Route
          path="/sequences"
          element={
            <Suspense fallback={<Loading />}>
              <Sequences />
            </Suspense>
          }
        />
        <Route
          path="/instantly"
          element={
            <Suspense fallback={<Loading />}>
              <Instantly />
            </Suspense>
          }
        />
        <Route
          path="/costs"
          element={
            <Suspense fallback={<Loading />}>
              <Costs />
            </Suspense>
          }
        />
        <Route
          path="/setups"
          element={
            <Suspense fallback={<Loading />}>
              <Setups />
            </Suspense>
          }
        />
        <Route
          path="/insights"
          element={
            <Suspense fallback={<Loading />}>
              <Insights />
            </Suspense>
          }
        />
        <Route
          path="/settings"
          element={
            <Suspense fallback={<Loading />}>
              <Settings />
            </Suspense>
          }
        />
        <Route
          path="*"
          element={
            <Suspense fallback={<Loading />}>
              <Dashboard />
            </Suspense>
          }
        />
      </Route>
    </Routes>
  );
}
