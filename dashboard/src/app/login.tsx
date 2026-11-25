import { Input } from "@ui-sdk/react/input";
import { useRef, useState } from "react";

import { Button } from "../shared/ui/button";
import { Brand } from "./brand";

export function Login({ onUnlock }: { onUnlock: (password: string) => Promise<string | null> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passwordField = useRef<HTMLInputElement>(null);

  const unlock = async () => {
    setPending(true);
    setError(null);
    try {
      const message = await onUnlock(value);
      setError(message);
      if (message) passwordField.current?.focus();
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="grid h-full place-items-center p-6">
      <form
        className="grid w-full max-w-95 gap-3.5 rounded-[14px] border border-edge bg-panel p-7 shadow-alas-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) void unlock();
        }}
      >
        <Brand />
        <div>
          <h2>Password required</h2>
          <p className="text-subtle text-xs">
            This server is protected. The password is kept for this browser tab only.
          </p>
        </div>
        <label className="sr-only" htmlFor="password">
          Password
        </label>
        <div>
          <Input
            ref={passwordField}
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            data-agent-secret
            required
            readOnly={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "password-error" : undefined}
            placeholder="Password"
            value={value}
            onValueChange={(next) => {
              setValue(next);
              setError(null);
            }}
          />
          <div id="password-error" role="alert" className="text-sm text-bad not-empty:mt-2">
            {error}
          </div>
        </div>
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
    </div>
  );
}
