'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2, Users2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslation } from '@/lib/i18n/use-translation';
import type { Profile, Team, TeamMember } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

/**
 * Account-wide CRUD manager for agent teams — a name plus a set of
 * member user_ids. Members reference `team_members.user_id` →
 * `auth.users(id)`, the same id `conversations.assigned_agent_id`
 * stores, so a team's roster can feed the round-robin RPC directly.
 * There's no FK from team_members to profiles (only to auth.users),
 * so member names are stitched together client-side against the
 * account's profile list rather than via a PostgREST embed.
 */
export function TeamsManager() {
  const supabase = createClient();
  const { accountId } = useAuth();
  const { t } = useTranslation();

  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [saving, setSaving] = useState(false);

  const [membersDialogTeam, setMembersDialogTeam] = useState<Team | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [savingMembers, setSavingMembers] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [teamsRes, membersRes, profilesRes] = await Promise.all([
      supabase.from('teams').select('*').order('name'),
      supabase.from('team_members').select('*'),
      supabase.from('profiles').select('*').order('full_name'),
    ]);
    if (teamsRes.error || membersRes.error || profilesRes.error) {
      toast.error(t('settings.teams.errorLoad'));
    } else {
      setTeams((teamsRes.data as Team[] | null) ?? []);
      setMembers((membersRes.data as TeamMember[] | null) ?? []);
      setProfiles((profilesRes.data as Profile[] | null) ?? []);
    }
    setLoading(false);
  }, [supabase, accountId, t]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAll();
    }
  }, [accountId, fetchAll]);

  function membersFor(teamId: string): TeamMember[] {
    return members.filter((m) => m.team_id === teamId);
  }

  function profileName(userId: string): string {
    return profiles.find((p) => p.user_id === userId)?.full_name || userId;
  }

  function openCreate() {
    setEditingTeam(null);
    setNameInput('');
    setNameDialogOpen(true);
  }

  function openRename(team: Team) {
    setEditingTeam(team);
    setNameInput(team.name);
    setNameDialogOpen(true);
  }

  async function handleSaveName() {
    const name = nameInput.trim();
    if (!name || !accountId) return;

    setSaving(true);
    const { error } = editingTeam
      ? await supabase.from('teams').update({ name }).eq('id', editingTeam.id)
      : await supabase.from('teams').insert({ account_id: accountId, name });
    setSaving(false);

    if (error) {
      toast.error(t('settings.teams.errorSave'));
      return;
    }
    toast.success(
      editingTeam ? t('settings.teams.updated', { name }) : t('settings.teams.created', { name }),
    );
    setNameDialogOpen(false);
    await fetchAll();
  }

  async function toggleAutoAssign(team: Team) {
    setBusyId(team.id);
    const { error } = await supabase
      .from('teams')
      .update({ auto_assign_enabled: !team.auto_assign_enabled })
      .eq('id', team.id);
    setBusyId(null);
    if (error) {
      toast.error(t('settings.teams.errorSave'));
      return;
    }
    await fetchAll();
  }

  async function handleDelete(team: Team) {
    if (!window.confirm(t('settings.teams.confirmDelete', { name: team.name }))) return;
    setBusyId(team.id);
    const { error } = await supabase.from('teams').delete().eq('id', team.id);
    setBusyId(null);
    if (error) {
      toast.error(t('settings.teams.errorDelete'));
      return;
    }
    toast.success(t('settings.teams.deleted', { name: team.name }));
    await fetchAll();
  }

  function openMembers(team: Team) {
    setMembersDialogTeam(team);
    setSelectedUserIds(new Set(membersFor(team.id).map((m) => m.user_id)));
  }

  function toggleMember(userId: string) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function handleSaveMembers() {
    if (!membersDialogTeam || !accountId) return;
    const teamId = membersDialogTeam.id;
    const current = new Set(membersFor(teamId).map((m) => m.user_id));
    const toAdd = [...selectedUserIds].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !selectedUserIds.has(id));

    setSavingMembers(true);
    const [addRes, removeRes] = await Promise.all([
      toAdd.length > 0
        ? supabase.from('team_members').insert(
            toAdd.map((user_id) => ({ team_id: teamId, user_id, account_id: accountId })),
          )
        : Promise.resolve({ error: null }),
      toRemove.length > 0
        ? supabase.from('team_members').delete().eq('team_id', teamId).in('user_id', toRemove)
        : Promise.resolve({ error: null }),
    ]);
    setSavingMembers(false);

    if (addRes.error || removeRes.error) {
      toast.error(t('settings.teams.errorSaveMembers'));
      return;
    }
    toast.success(t('settings.teams.membersUpdated', { name: membersDialogTeam.name }));
    setMembersDialogTeam(null);
    await fetchAll();
  }

  return (
    <div>
      <SettingsPanelHead
        title={t('settings.teams.title')}
        description={t('settings.teams.description')}
        action={
          <Button
            onClick={openCreate}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4" />
            {t('settings.teams.add')}
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.teams.loading')}
        </div>
      ) : teams.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('settings.teams.noTeamsYet')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {teams.map((team) => {
            const teamMembers = membersFor(team.id);
            return (
              <Card key={team.id}>
                <CardContent className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Users2 className="size-4 text-muted-foreground" />
                      <span className="font-medium text-foreground">{team.name}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {teamMembers.length === 0
                        ? t('settings.teams.noMembers')
                        : teamMembers.map((m) => profileName(m.user_id)).join(', ')}
                    </p>
                    <label className="mt-2 flex items-center gap-2">
                      <Checkbox
                        checked={team.auto_assign_enabled}
                        disabled={busyId === team.id}
                        onCheckedChange={() => toggleAutoAssign(team)}
                      />
                      <span className="text-sm text-muted-foreground">
                        {t('settings.teams.autoAssignEnabled')}
                      </span>
                    </label>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === team.id}
                      onClick={() => openMembers(team)}
                      className="border-border"
                    >
                      {t('settings.teams.manageMembers')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busyId === team.id}
                      onClick={() => openRename(team)}
                      title={t('settings.teams.editTitle')}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busyId === team.id}
                      onClick={() => handleDelete(team)}
                      title={t('settings.teams.deleteTitle')}
                      className="text-muted-foreground hover:text-red-400"
                    >
                      {busyId === team.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create / rename */}
      <Dialog open={nameDialogOpen} onOpenChange={setNameDialogOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editingTeam ? t('settings.teams.editDialogTitle') : t('settings.teams.newDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('settings.teams.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <Input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSaveName();
              }
            }}
            placeholder={t('settings.teams.namePlaceholder')}
            className="bg-muted text-foreground"
          />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNameDialogOpen(false)}
              className="border-border"
            >
              {t('settings.teams.cancel')}
            </Button>
            <Button
              onClick={handleSaveName}
              disabled={saving || !nameInput.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('settings.teams.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage members */}
      <Dialog
        open={membersDialogTeam !== null}
        onOpenChange={(open) => !open && setMembersDialogTeam(null)}
      >
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('settings.teams.membersDialogTitle', { name: membersDialogTeam?.name ?? '' })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('settings.teams.membersDialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {profiles.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t('settings.teams.noProfilesAvailable')}
              </p>
            ) : (
              profiles.map((profile) => (
                <label
                  key={profile.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                >
                  <Checkbox
                    checked={selectedUserIds.has(profile.user_id)}
                    onCheckedChange={() => toggleMember(profile.user_id)}
                  />
                  <span className="text-sm text-popover-foreground">{profile.full_name}</span>
                </label>
              ))
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMembersDialogTeam(null)}
              className="border-border"
            >
              {t('settings.teams.cancel')}
            </Button>
            <Button
              onClick={handleSaveMembers}
              disabled={savingMembers}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {savingMembers ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('settings.teams.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
