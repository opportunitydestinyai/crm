// lib/agenda/aviso-ao-agendar.handler.ts
/**
 * Adapter fino: pluga `aplicaAvisoAoAgendar` no dreno do `event_log`, reusando a
 * leitura de configuração, o transporte e o pacing do aviso de caso. Imports de
 * topo iguais aos de `lib/propostas/aviso-no-whatsapp.handler.ts` — o dreno
 * carrega isto sob `tsx`, e import pesado de topo já o parou (#648).
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { audit } from "@/lib/audit";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { env } from "@/lib/env";
import { createSupabaseAvisoDb } from "@/lib/escalacao/aviso-ao-suporte";
import { criarTransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte.handler";
import { origemDoDreno } from "@/lib/event-log/origem-do-dreno";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVENTO_AGENDAMENTO_CRIADO, aplicaAvisoAoAgendar } from "./aviso-ao-agendar";

export const AVISO_AO_AGENDAR_HANDLER_KEY = "agenda-aviso-ao-agendar.v1";

export const avisoAoAgendarNoWhatsAppHandler: EventHandler = {
  key: AVISO_AO_AGENDAR_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_AGENDAMENTO_CRIADO],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const doCaso = createSupabaseAvisoDb(admin);
      const desfecho = await aplicaAvisoAoAgendar(
        {
          db: {
            carregaConfig: (orgId) => doCaso.carregaConfig(orgId),
            async carregaCompromisso(orgId, id) {
              const { data } = await admin
                .from("calendar_appointments")
                .select("starts_at, time_zone, created_by_kind")
                .eq("organization_id", orgId)
                .eq("id", id)
                .maybeSingle();
              return (data as { starts_at: string | null; time_zone: string | null; created_by_kind: string | null } | null) ?? null;
            },
            async carregaContato(orgId, contactId) {
              const { data } = await admin
                .from("contacts")
                .select("name, display_name, phone_number")
                .eq("organization_id", orgId)
                .eq("id", contactId)
                .maybeSingle();
              const c = data as { name: string | null; display_name: string | null; phone_number: string | null } | null;
              if (!c) return null;
              return {
                nome: nomeDoContato({ name: c.name, display_name: c.display_name }),
                telefone: c.phone_number ? phoneForDisplay(c.phone_number) : null,
              };
            },
            carregaCanal: (orgId, canalId) => doCaso.carregaCanal(orgId, canalId),
            registraJidDoAviso: (orgId, jid) => doCaso.registraJidDoAviso(orgId, jid),
            marcaDaOrganizacao: (orgId) => doCaso.marcaDaOrganizacao(orgId),
          },
          transporte: await criarTransporteDoAviso(admin),
          pacing: await criarPacingDoCanal(admin),
          clock: () => new Date(),
          urlPublica: env.NEXT_PUBLIC_APP_URL,
          origemDoDreno,
          audita: (entrada) => {
            void audit({
              action: entrada.action,
              organizationId: entrada.organizationId,
              resourceType: "calendar_appointment",
              resourceId: entrada.appointmentId,
              bypassedRls: true,
              metadata: entrada.metadata,
            });
          },
        },
        row,
      );
      return {
        consumer_key: AVISO_AO_AGENDAR_HANDLER_KEY,
        status: desfecho.status,
        ...(desfecho.retry_at ? { retry_at: desfecho.retry_at } : {}),
        detail: desfecho.detail,
      };
    } catch (err) {
      return { consumer_key: AVISO_AO_AGENDAR_HANDLER_KEY, status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
