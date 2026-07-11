'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTranslation } from '@/lib/i18n/use-translation';
import { toast } from 'sonner';
import type { Contact, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

interface MergeContactsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactA: ContactWithTags;
  contactB: ContactWithTags;
  accountId: string;
  onMerged: () => void;
}

export function MergeContactsDialog({
  open,
  onOpenChange,
  contactA,
  contactB,
  accountId,
  onMerged,
}: MergeContactsDialogProps) {
  const supabase = createClient();
  const { t } = useTranslation();
  const [survivorId, setSurvivorId] = useState(contactA.id);
  const [merging, setMerging] = useState(false);

  const options = [contactA, contactB];

  async function handleMerge() {
    const survivor = survivorId === contactA.id ? contactA : contactB;
    const loser = survivorId === contactA.id ? contactB : contactA;

    setMerging(true);
    const { error } = await supabase.rpc('merge_contacts', {
      p_survivor_id: survivor.id,
      p_loser_id: loser.id,
      p_account_id: accountId,
    });
    setMerging(false);

    if (error) {
      toast.error(t('contacts.merge.error'));
      return;
    }

    toast.success(t('contacts.merge.success'));
    onOpenChange(false);
    onMerged();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('contacts.merge.title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('contacts.merge.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          {options.map((contact) => (
            <button
              key={contact.id}
              type="button"
              onClick={() => setSurvivorId(contact.id)}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                survivorId === contact.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50',
              )}
            >
              <p className="font-medium text-foreground truncate">
                {contact.name || t('contacts.page.unnamed')}
              </p>
              <p className="text-sm text-muted-foreground truncate">{contact.phone}</p>
              {contact.email && (
                <p className="text-sm text-muted-foreground truncate">{contact.email}</p>
              )}
              {contact.tags && contact.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {contact.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded-full px-2 py-0.5 text-xs"
                      style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}
              {survivorId === contact.id && (
                <p className="mt-2 text-xs font-medium text-primary">
                  {t('contacts.merge.keepThisOne')}
                </p>
              )}
            </button>
          ))}
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={merging}>
            {t('contacts.page.cancel')}
          </Button>
          <Button onClick={handleMerge} disabled={merging}>
            {merging && <Loader2 className="size-4 animate-spin" />}
            {t('contacts.merge.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
