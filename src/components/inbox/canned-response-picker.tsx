"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { CannedResponse } from "@/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageSquareText, Loader2 } from "lucide-react";
import { useTranslation } from "@/lib/i18n/use-translation";

interface CannedResponsePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only inserts text into the composer — never sends by itself. */
  onSelect: (body: string) => void;
}

/**
 * Search-and-insert dialog for canned responses. Unlike TemplatePicker,
 * there's no variable-filling step and no send action here — picking a
 * response just hands its body text back to the caller so the agent can
 * still edit it before sending.
 */
export function CannedResponsePicker({
  open,
  onOpenChange,
  onSelect,
}: CannedResponsePickerProps) {
  const { t } = useTranslation();
  const [responses, setResponses] = useState<CannedResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const { data, error } = await supabase
        .from("canned_responses")
        .select("*")
        .order("title");

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch canned responses:", error);
        setResponses([]);
      } else {
        setResponses((data as CannedResponse[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return responses;
    const q = search.toLowerCase();
    return responses.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.shortcut.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q),
    );
  }, [responses, search]);

  function handleOpenChange(next: boolean) {
    if (!next) setSearch("");
    onOpenChange(next);
  }

  function pick(response: CannedResponse) {
    onSelect(response.body);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <MessageSquareText className="h-4 w-4 text-primary" />
            {t("inbox.cannedResponsePicker.title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("inbox.cannedResponsePicker.description")}
          </DialogDescription>
        </DialogHeader>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("inbox.cannedResponsePicker.searchPlaceholder")}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          autoFocus
        />

        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-border bg-background/50 p-6 text-center">
              <p className="text-sm text-popover-foreground">
                {t("inbox.cannedResponsePicker.noResponsesFound")}
              </p>
            </div>
          ) : (
            filtered.map((response) => (
              <button
                key={response.id}
                type="button"
                onClick={() => pick(response)}
                className="w-full rounded-md border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-popover"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-popover-foreground">
                    {response.title}
                  </p>
                  <span className="text-[10px] text-muted-foreground">
                    /{response.shortcut}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {response.body}
                </p>
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-popover-foreground hover:bg-muted"
          >
            {t("inbox.cannedResponsePicker.cancelButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
