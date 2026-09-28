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

/** Riesgos que la auditoría marca para revisión con el gimnasio. */
const FLAGGED_RISKS: readonly GrantRisk[] = [
  GrantRisk.WILDCARD,
  GrantRisk.MANAGE,
  GrantRisk.WRITE,
];

/** Una fila `plan × permisos` tal y como sale de la base de datos. */
export interface PlanGrantRow {
  planId: string;
  planName: string;
  /** `null` en planes huérfanos, sin empresa asignada. */
  companyId: string | null;
  companyName: string | null;
  /** `active` | `inactive` | `archived`. */
  status: string;
  isActive: boolean;
  /** Número de Session Credits si es un Session Pack; `null` si es ilimitado. */
  sessionCount: number | null;
  /** Nombres de permiso activos del plan, p. ej. `schedules:read`. */
  grants: string[];
}

/** Un plan vivo, con sus permisos clasificados. */
export interface AuditedPlan {
  planId: string;
  planName: string;
  sessionCount: number | null;
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
  companyName: string | null;
  planName: string;
  risks: GrantRisk[];
  /** Solo los permisos que motivan el marcado, por riesgo descendente. */
  offendingGrants: string[];
}

/** El informe completo de la auditoría. */
export interface PlanPermissionAudit {
  companies: AuditedCompany[];
  flagged: FlaggedPlan[];
  totalPlansAudited: number;
}

/**
 * El alcance de un permiso por su nombre.
 *
 * @remarks Refleja lo que `PermissionService.hasPermission` resuelve de verdad:
 * `*:*` y `<módulo>:manage` son ramas explícitas ahí, así que aquí son riesgos
 * propios y no simple escritura.
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

/** Un plan cuenta como vivo si un miembro puede sostenerlo hoy. */
function isLive(row: PlanGrantRow): boolean {
  return row.isActive && row.status === 'active';
}

/** Clave de agrupación estable, también para los planes sin empresa. */
function companyKey(row: PlanGrantRow): string {
  return row.companyId ?? '';
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
  const live = rows.filter(isLive);

  const byCompany = new Map<string, PlanGrantRow[]>();
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

  const flagged: FlaggedPlan[] = companies.flatMap(company =>
    company.plans
      .filter(plan => plan.risks.length > 0)
      .map(plan => ({
        companyName: company.companyName,
        planName: plan.planName,
        risks: plan.risks,
        offendingGrants: plan.risks.flatMap(
          risk => plan.grantsByRisk[risk] ?? []
        ),
      }))
  );

  return { companies, flagged, totalPlansAudited: live.length };
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
    grants,
    grantsByRisk,
    risks: FLAGGED_RISKS.filter(risk => grantsByRisk[risk]),
    beyondBaseline: grants.filter(g => !baseline.includes(g)),
  };
}

const NO_COMPANY = '(sin empresa)';

/**
 * El informe en Markdown, listo para pegar en el issue #17.
 *
 * @remarks El issue pide que el resultado quede registrado; este formato es el
 * entregable, no un log de depuración.
 */
export function formatAuditMarkdown(report: PlanPermissionAudit): string {
  const lines: string[] = [
    '## Auditoría de permisos por plan',
    '',
    `Planes vivos auditados: **${report.totalPlansAudited}** ` +
      `en **${report.companies.length}** empresas. ` +
      `Marcados para revisión: **${report.flagged.length}**.`,
    '',
  ];

  for (const company of report.companies) {
    lines.push(`### ${company.companyName ?? NO_COMPANY}`);
    lines.push('');
    lines.push(
      `Línea base (todos los planes): \`${company.baseline.join('`, `') || '—'}\``
    );
    lines.push('');
    lines.push('| Plan | Bono | Riesgo | Permisos | Por encima de la base |');
    lines.push('| --- | --- | --- | --- | --- |');

    for (const plan of company.plans) {
      lines.push(
        `| ${plan.planName} ` +
          `| ${plan.sessionCount ?? '—'} ` +
          `| ${plan.risks.join(', ') || '—'} ` +
          `| ${plan.grants.join(', ') || '—'} ` +
          `| ${plan.beyondBaseline.join(', ') || '—'} |`
      );
    }
    lines.push('');
  }

  lines.push('### Marcados para revisar con el gimnasio');
  lines.push('');
  if (report.flagged.length === 0) {
    lines.push('Ninguno.');
  } else {
    for (const plan of report.flagged) {
      lines.push(
        `- **${plan.planName}** (${plan.companyName ?? NO_COMPANY}) — ` +
          `${plan.risks.join(', ')}: \`${plan.offendingGrants.join('`, `')}\``
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}
