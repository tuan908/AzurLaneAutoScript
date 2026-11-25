// Must stay the first import: zod/compile only JIT-compiles schemas created after it loads,
// and every module below builds schemas at top level.
import "zod/compile";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createQueryClient } from "./app/query-client";
import { router } from "./app/router";

import "./styles.css";

const queryClient = createQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
