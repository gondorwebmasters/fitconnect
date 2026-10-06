import { PlanStatus } from '../../entities/Plan';
import {
  auditPlanPermissions,
  classifyGrant,
  formatAuditMarkdown,
  GrantRisk,
  PlanGrantRow,
} from '../plan-permission-audit.util';

/**
 * Tests del seam de auditoría de permisos por plan — issue #17.
 *
 * La auditoría gatea la unión de permisos (#15/#19): antes de que un miembro
 * pueda sostener varios planes a la vez hay que saber qué concede cada uno.
 * El seam es puro — recibe filas planas, no entidades — para poder afirmar
 * sobre el informe sin base de datos.
 */
describe('classifyGrant', () => {
  it('marca `*:*` como comodín', () => {
    expect(classifyGrant('*:*')).toBe(GrantRisk.WILDCARD);
  });

  it('marca `<módulo>:manage` como permiso de gestión', () => {
    expect(classifyGrant('schedules:manage')).toBe(GrantRisk.MANAGE);
    expect(classifyGrant('companies:manage')).toBe(GrantRisk.MANAGE);
  });

  it('marca create/update/delete como escritura', () => {
    expect(classifyGrant('schedules:create')).toBe(GrantRisk.WRITE);
    expect(classifyGrant('users:update')).toBe(GrantRisk.WRITE);
    expect(classifyGrant('user_weights:delete')).toBe(GrantRisk.WRITE);
  });

  it('no marca la lectura', () => {
    expect(classifyGrant('schedules:read')).toBe(GrantRisk.READ);
  });
});

describe('auditPlanPermissions', () => {
  function row(overrides: Partial<PlanGrantRow> = {}): PlanGrantRow {
    return {
      planId: 'plan-1',
      planName: 'Mensualidad',
      companyId: 'comp-1',
      companyName: 'Gimnasio Uno',
      status: PlanStatus.ACTIVE,
      isActive: true,
      sessionCount: null,
      liveSubscriptions: 0,
      grants: ['schedules:read', 'users:read'],
      ...overrides,
    };
  }

  it('agrupa los planes por empresa', () => {
    const report = auditPlanPermissions([
      row(),
      row({ planId: 'plan-2', planName: 'Bono', sessionCount: 4 }),
      row({
        planId: 'plan-3',
        companyId: 'comp-2',
        companyName: 'Gimnasio Dos',
      }),
    ]);

    expect(report.companies).toHaveLength(2);
    expect(report.companies[0].companyName).toBe('Gimnasio Uno');
    expect(report.companies[0].plans).toHaveLength(2);
    expect(report.companies[1].plans).toHaveLength(1);
  });

  it('agrupa los planes huérfanos bajo una empresa sin nombre', () => {
    const report = auditPlanPermissions([
      row({ companyId: null, companyName: null }),
    ]);

    expect(report.companies[0].companyId).toBeNull();
    expect(report.companies[0].plans).toHaveLength(1);
  });

  it('descarta el plan archivado que ya nadie sostiene', () => {
    const report = auditPlanPermissions([
      row(),
      row({ planId: 'plan-2', status: PlanStatus.ARCHIVED }),
      row({ planId: 'plan-3', isActive: false }),
    ]);

    expect(report.totalPlansAudited).toBe(1);
    expect(report.companies[0].plans.map(p => p.planId)).toEqual(['plan-1']);
  });

  it('audita el plan archivado que alguien todavía sostiene', () => {
    // Archivar un plan nunca cancela sus suscripciones (PlanService.archivePlan),
    // así que sus permisos siguen entrando en la unión.
    const report = auditPlanPermissions([
      row({
        planId: 'plan-2',
        status: PlanStatus.ARCHIVED,
        isActive: false,
        liveSubscriptions: 1,
        grants: ['users:manage'],
      }),
    ]);

    expect(report.totalPlansAudited).toBe(1);
    expect(report.flagged).toHaveLength(1);
    expect(report.companies[0].plans[0].isSelectable).toBe(false);
  });

  it('distingue el plan que se puede contratar del que solo se sostiene', () => {
    const report = auditPlanPermissions([
      row({ planId: 'a' }),
      row({
        planId: 'b',
        status: PlanStatus.ARCHIVED,
        isActive: false,
        liveSubscriptions: 2,
      }),
    ]);
    const [a, b] = report.companies[0].plans;

    expect(a.isSelectable).toBe(true);
    expect(b.isSelectable).toBe(false);
    expect(b.liveSubscriptions).toBe(2);
  });

  it('marca el plan que concede un comodín', () => {
    const report = auditPlanPermissions([row({ grants: ['*:*'] })]);
    const plan = report.companies[0].plans[0];

    expect(plan.risks).toContain(GrantRisk.WILDCARD);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].planName).toBe('Mensualidad');
    expect(report.flagged[0].offendingGrants).toEqual(['*:*']);
  });

  it('separa la escritura del marcado que pide el issue', () => {
    // El issue marca comodín y gestión; la escritura se revisa aparte.
    const report = auditPlanPermissions([
      row({ planId: 'w', grants: ['schedules:read', 'schedules:create'] }),
      row({ planId: 'm', grants: ['users:manage'] }),
    ]);

    expect(report.flagged.map(f => f.planName)).toEqual(['Mensualidad']);
    expect(report.flagged[0].offendingGrants).toEqual(['users:manage']);
    expect(report.writeGrants).toHaveLength(1);
    expect(report.writeGrants[0].offendingGrants).toEqual(['schedules:create']);
  });

  it('marca el plan que concede gestión y lista los permisos culpables', () => {
    const report = auditPlanPermissions([
      row({ grants: ['schedules:read', 'users:manage', 'plans:manage'] }),
    ]);
    const plan = report.companies[0].plans[0];

    expect(plan.risks).toContain(GrantRisk.MANAGE);
    expect(plan.grantsByRisk[GrantRisk.MANAGE]).toEqual([
      'plans:manage',
      'users:manage',
    ]);
  });

  it('lista en el marcado solo los permisos culpables, no la lectura', () => {
    const report = auditPlanPermissions([
      row({ grants: ['schedules:read', 'users:manage', 'schedules:create'] }),
    ]);

    expect(report.flagged[0].offendingGrants).toEqual([
      'users:manage',
      'schedules:create',
    ]);
  });

  it('no marca como escritura un plan que ya está marcado por gestión', () => {
    const report = auditPlanPermissions([
      row({ grants: ['users:manage', 'schedules:create'] }),
    ]);

    expect(report.flagged).toHaveLength(1);
    expect(report.writeGrants).toEqual([]);
  });

  it('no marca un plan que solo concede lectura', () => {
    const report = auditPlanPermissions([row()]);

    expect(report.companies[0].plans[0].risks).toEqual([]);
    expect(report.flagged).toEqual([]);
    expect(report.writeGrants).toEqual([]);
  });

  it('marca la escritura por separado, sin confundirla con gestión', () => {
    const report = auditPlanPermissions([
      row({ grants: ['schedules:read', 'schedules:create'] }),
    ]);
    const plan = report.companies[0].plans[0];

    expect(plan.risks).toEqual([GrantRisk.WRITE]);
    expect(plan.grantsByRisk[GrantRisk.WRITE]).toEqual(['schedules:create']);
  });

  it('cuenta un plan sin permisos como vivo pero sin riesgo', () => {
    const report = auditPlanPermissions([row({ grants: [] })]);

    expect(report.totalPlansAudited).toBe(1);
    expect(report.companies[0].plans[0].risks).toEqual([]);
  });

  it('señala qué planes conceden más que la línea base de su empresa', () => {
    const report = auditPlanPermissions([
      row({ planId: 'a', grants: ['schedules:read', 'users:read'] }),
      row({ planId: 'b', grants: ['schedules:read', 'users:read'] }),
      row({
        planId: 'c',
        grants: ['schedules:read', 'users:read', 'schedules:create'],
      }),
    ]);
    const [a, b, c] = report.companies[0].plans;

    expect(a.beyondBaseline).toEqual([]);
    expect(b.beyondBaseline).toEqual([]);
    expect(c.beyondBaseline).toEqual(['schedules:create']);
  });
});

describe('formatAuditMarkdown', () => {
  it('renderiza una tabla por empresa y una sección de marcados', () => {
    const report = auditPlanPermissions([
      {
        planId: 'plan-1',
        planName: 'Plan Tufado',
        companyId: null,
        companyName: null,
        status: PlanStatus.ACTIVE,
        isActive: true,
        sessionCount: null,
        liveSubscriptions: 0,
        grants: ['companies:manage'],
      },
    ]);

    const md = formatAuditMarkdown(report);

    expect(md).toContain('Plan Tufado');
    expect(md).toContain('companies:manage');
    expect(md).toContain('sin empresa');
  });
});
