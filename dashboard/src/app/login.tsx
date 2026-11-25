import { Input } from "@ui-sdk/react/input";
import { useState } from "react";
import { setToken } from "../api/client";
import { Button } from "../shared/ui/button";
import { Brand } from "./brand";

export function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="grid h-full place-items-center p-6">
      <form
        className="grid w-full max-w-95 gap-3.5 rounded-[14px] border border-edge bg-panel p-7 shadow-alas-lg"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value);
          onDone();
        }}
      >
        <Brand />
        <div>
          <h2>Password required</h2>
          <p className="text-subtle text-xs">This server is protected. The password is kept for this browser tab only.</p>
        </div>
        <label className="sr-only" htmlFor="password">Password</label>
        <Input id="password" type="password" data-agent-secret required placeholder="Password" value={value} onValueChange={setValue} />
        <Button variant="primary" type="submit">Unlock</Button>
      </form>
    </div>
  );
}
