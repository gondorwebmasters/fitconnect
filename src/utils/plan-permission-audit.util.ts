/**
 * Auditoría de **qué concede cada Plan** — issue #17.
 *
 * Hoy un miembro sostiene un plan cada vez y un administrador lo eligió a
 * conciencia, así que un plan con permisos de más es inofensivo. Deja de serlo
 * en cuanto los permisos pasan a ser la **unión** de los planes del
 * **Entitlement** (ver CONTEXT.md → Entitlement y ADR 0006): el plan más
 * permisivo gana mientras el miembro lo tenga, y un **Session Pack** barato
 * arrastraría sus permisos a una membresía que nunca quiso elevar.
 *
 * El seam es puro a propósito: recibe filas planas, no entidades, para que el
 * informe se pueda afirmar en tests sin base de datos y para que el script que
 * lo ejecuta (`src/scripts/audit-plan-permissions.ts`) sea una cáscara fina.
 */

import { PlanStatus } from '../entities/Plan';

/** Qué tan lejos llega un permiso concedido por un plan. */
export enum GrantRisk {
  /** `*:*` — concede absolutamente todo. */
  WILDCARD = 'wildcard',
  /** `<módulo>:manage` — concede toda acción del módulo, presente y futura. */
  MANAGE = 'manage',
  /** `create` / `update` / `delete` — escribe en un módulo. */
  WRITE = 'write',
  /** `read` y cualquier otra acción de solo lectura. */
  READ = 'read',
}

/**
 * Riesgos que el issue #17 pide marcar: «cualquier plan que conceda un comodín
 * o un permiso de gestión».
 */
const FLAGGED_RISKS: readonly GrantRisk[] = [
  GrantRisk.WILDCARD,
  GrantRisk.MANAGE,
];

/** Riesgos de los que la auditoría informa, marcados o no. */
const REPORTED_RISKS: readonly GrantRisk[] = [
  ...FLAGGED_RISKS,
  GrantRisk.WRITE,
];

/** Una fila `plan × permisos` tal y como sale de la base de datos. */
export interface PlanGrantRow {
  planId: string;
  planName: string;
  /** `null` en planes huérfanos, sin empresa asignada. */
  companyId: string | null;
  companyName: string | null;
  status: PlanStatus;
  isActive: boolean;
  /** Número de Session Credits si es un Session Pack; `null` si es ilimitado. */
  sessionCount: number | null;
  /** Suscripciones `ACTIVE`/`TRIALING` que sostienen el plan ahora mismo. */
  liveSubscriptions: number;
  /** Nombres de permiso activos del plan, p. ej. `schedules:read`. */
  grants: string[];
}

/** Un plan vivo, con sus permisos clasificados. */
export interface AuditedPlan {
  planId: string;
  planName: string;
  sessionCount: number | null;
  /** Si un miembro puede contratarlo hoy; un archivado sostenido no lo es. */
  isSelectable: boolean;
  liveSubscriptions: number;
  grants: string[];
  /** Permisos agrupados por riesgo; solo aparecen los riesgos presentes. */
  grantsByRisk: Partial<Record<GrantRisk, string[]>>;
  /** Riesgos marcados para revisión, de mayor a menor alcance. */
  risks: GrantRisk[];
  /** Permisos que este plan concede y la línea base de su empresa no. */
  beyondBaseline: string[];
}

/** Los planes vivos de una empresa. */
export interface AuditedCompany {
  companyId: string | null;
  companyName: string | null;
  plans: AuditedPlan[];
  /** Permisos que conceden **todos** los planes vivos de la empresa. */
  baseline: string[];
}

/** Un plan marcado, aplanado para la lista de revisión. */
export interface FlaggedPlan {
  planId: string;
  companyName: string | null;
  planName: string;
  risks: GrantRisk[];
  /** Solo los permisos que motivan el marcado, por riesgo descendente. */
  offendingGrants: string[];
}

/** El informe completo de la auditoría. */
export interface PlanPermissionAudit {
  companies: AuditedCompany[];
  /** Planes con comodín o gestión: lo que el issue #17 manda revisar. */
  flagged: FlaggedPlan[];
  /** Planes que solo conceden escritura: revisión secundaria. */
  writeGrants: FlaggedPlan[];
  totalPlansAudited: number;
}

/**
 * El alcance de un permiso por su nombre.
 *
 * @remarks Refleja lo que `PermissionService.userHasPermissionInCompany`
 * resuelve de verdad:
 * `*:*` y `<módulo>:manage` son ramas explícitas ahí, así que aquí son riesgos
 * propios y no simple escritura.
 *
 * @param grant - Nombre del permiso, p. ej. `schedules:create`.
 * @returns El riesgo que representa concederlo.
 */
export function classifyGrant(grant: string): GrantRisk {
  if (grant === '*:*') return GrantRisk.WILDCARD;

  const action = grant.split(':')[1];
  if (action === 'manage') return GrantRisk.MANAGE;
  if (action === 'create' || action === 'update' || action === 'delete') {
    return GrantRisk.WRITE;
  }
  return GrantRisk.READ;
}

/** Si un miembro puede contratar el plan hoy. */
function isSelectable(row: PlanGrantRow): boolean {
  return row.isActive && row.status === PlanStatus.ACTIVE;
}

/**
 * Un plan entra en la auditoría si sus permisos pueden llegar a la unión.
 *
 * @remarks No basta con mirar `status`/`isActive`: `PlanService.archivePlan`
 * archiva **sin** cancelar las suscripciones existentes (ADR 0005), y la
 * resolución de permisos parte de la suscripción viva, nunca del estado del
 * plan. Un plan archivado que alguien todavía sostiene sigue concediendo.
 */
function isAuditable(row: PlanGrantRow): boolean {
  return isSelectable(row) || row.liveSubscriptions > 0;
}

/**
 * Clave de agrupación estable, también para los planes huérfanos.
 *
 * @remarks El centinela no puede ser `''`: un `companyId` vacío en la base de
 * datos se mezclaría con los planes sin empresa.
 */
const NO_COMPANY_KEY = Symbol('sin empresa');

function companyKey(row: PlanGrantRow): string | symbol {
  return row.companyId ?? NO_COMPANY_KEY;
}

/**
 * Clasifica los permisos de cada plan vivo y los agrupa por empresa.
 *
 * @param rows - Filas `plan × permisos`, vivas o no; las no vivas se descartan.
 * @returns El informe: empresas con sus planes, y la lista plana de marcados.
 */
export function auditPlanPermissions(
  rows: PlanGrantRow[]
): PlanPermissionAudit {
  const live = rows.filter(isAuditable);

  const byCompany = new Map<string | symbol, PlanGrantRow[]>();
  for (const row of live) {
    const key = companyKey(row);
    const bucket = byCompany.get(key);
    if (bucket) bucket.push(row);
    else byCompany.set(key, [row]);
  }

  const companies: AuditedCompany[] = [...byCompany.values()].map(planRows => {
    const baseline = intersectGrants(planRows);

    return {
      companyId: planRows[0].companyId,
      companyName: planRows[0].companyName,
      baseline,
      plans: planRows.map(row => auditPlan(row, baseline)),
    };
  });

  const flagged = collectPlans(companies, FLAGGED_RISKS);
  // La escritura no la pide el issue, pero también viaja en la unión: va en su
  // propia lista para no diluir lo que el gimnasio tiene que mirar primero.
  const alreadyFlagged = new Set(flagged.map(plan => plan.planId));
  const writeGrants = collectPlans(companies, [GrantRisk.WRITE]).filter(
    plan => !alreadyFlagged.has(plan.planId)
  );

  return { companies, flagged, writeGrants, totalPlansAudited: live.length };
}

/** Aplana los planes de cada empresa que incurren en alguno de esos riesgos. */
function collectPlans(
  companies: AuditedCompany[],
  risks: readonly GrantRisk[]
): FlaggedPlan[] {
  return companies.flatMap(company =>
    company.plans
      .filter(plan => risks.some(risk => plan.grantsByRisk[risk]))
      .map(plan => ({
        planId: plan.planId,
        companyName: company.companyName,
        planName: plan.planName,
        risks: plan.risks,
        offendingGrants: plan.risks.flatMap(
          risk => plan.grantsByRisk[risk] ?? []
        ),
      }))
  );
}

/** Los permisos que conceden todos los planes de la empresa. */
function intersectGrants(rows: PlanGrantRow[]): string[] {
  const [first, ...rest] = rows;
  const shared = rest.reduce<Set<string>>(
    (acc, row) => new Set(row.grants.filter(g => acc.has(g))),
    new Set(first.grants)
  );
  return [...shared].sort();
}

function auditPlan(row: PlanGrantRow, baseline: string[]): AuditedPlan {
  const grants = [...row.grants].sort();

  const grantsByRisk: Partial<Record<GrantRisk, string[]>> = {};
  for (const grant of grants) {
    const risk = classifyGrant(grant);
    (grantsByRisk[risk] ??= []).push(grant);
  }

  return {
    planId: row.planId,
    planName: row.planName,
    sessionCount: row.sessionCount,
    isSelectable: isSelectable(row),
    liveSubscriptions: row.liveSubscriptions,
    grants,
    grantsByRisk,
    risks: REPORTED_RISKS.filter(risk => grantsByRisk[risk]),
    beyondBaseline: grants.filter(g => !baseline.includes(g)),
  };
}

const NO_COMPANY = '(sin empresa)';

/**
 * El informe en Markdown, listo para pegar en el issue #17.
 *
 * @remarks El issue pide que el resultado quede registrado; este formato es el
 * entregable, no un log de depuración.
 *
 * @param report - El informe devuelto por {@link auditPlanPermissions}.
 * @returns El informe en Markdown.
 */
export function formatAuditMarkdown(report: PlanPermissionAudit): string {
  const lines: string[] = [
    '## Auditoría de permisos por plan',
    '',
    `Planes vivos auditados: **${report.totalPlansAudited}** ` +
      `en **${report.companies.length}** empresas. ` +
      `Con comodín o gestión: **${report.flagged.length}**; ` +
      `solo con escritura: **${report.writeGrants.length}**.`,
    '',
  ];

  for (const company of report.companies) {
    lines.push(`### ${company.companyName ?? NO_COMPANY}`);
    lines.push('');
    lines.push(
      `Línea base (todos los planes): \`${company.baseline.join('`, `') || '—'}\``
    );
    lines.push('');
    lines.push(
      '| Plan | Bono | Vivas | Riesgo | Permisos | Por encima de la base |'
    );
    lines.push('| --- | --- | --- | --- | --- | --- |');

    for (const plan of company.plans) {
      const held = plan.isSelectable
        ? `${plan.liveSubscriptions}`
        : `${plan.liveSubscriptions} (archivado)`;
      lines.push(
        `| ${plan.planName} ` +
          `| ${plan.sessionCount ?? '—'} ` +
          `| ${held} ` +
          `| ${plan.risks.join(', ') || '—'} ` +
          `| ${plan.grants.join(', ') || '—'} ` +
          `| ${plan.beyondBaseline.join(', ') || '—'} |`
      );
    }
    lines.push('');
  }

  appendFlagged(
    lines,
    '### Comodín o gestión — revisar con el gimnasio',
    report.flagged
  );
  appendFlagged(
    lines,
    '### Solo escritura — revisión secundaria',
    report.writeGrants
  );

  return lines.join('\n');
}

function appendFlagged(
  lines: string[],
  heading: string,
  plans: FlaggedPlan[]
): void {
  lines.push(heading);
  lines.push('');
  if (plans.length === 0) {
    lines.push('Ninguno.');
  } else {
    for (const plan of plans) {
      lines.push(
        `- **${plan.planName}** (${plan.companyName ?? NO_COMPANY}) — ` +
          `${plan.risks.join(', ')}: \`${plan.offendingGrants.join('`, `')}\``
      );
    }
  }
  lines.push('');
}
