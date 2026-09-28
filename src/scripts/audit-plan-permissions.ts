import { MikroORM } from '@mikro-orm/core';

import { Plan } from '../entities/Plan';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import config from '../mikro-orm.config';
import { createRetryingEntityManager } from '../utils/orm-retry';
import {
  auditPlanPermissions,
  formatAuditMarkdown,
  PlanGrantRow,
} from '../utils/plan-permission-audit.util';

/**
 * Audita qué concede cada Plan vivo, por empresa — issue #17.
 *
 * Gatea la unión de permisos del Entitlement (#15/#19): imprime el informe en
 * Markdown para registrarlo en el issue. Es de **solo lectura**; corregir un
 * plan con permisos de más se hace después, revisado con el gimnasio.
 *
 * Uso: `npx ts-node src/scripts/audit-plan-permissions.ts`
 */
async function run() {
  console.log('🔄 Inicializando base de datos...');
  const orm = await MikroORM.init(config);
  // Segundo argumento: desactiva el filtro companyContext. La auditoría es
  // deliberadamente cross-tenant — recorre todas las empresas y nombra la de
  // cada plan.
  const em = createRetryingEntityManager(orm, true);

  try {
    const plans = await em.find(
      Plan,
      {},
      {
        filters: false,
        populate: ['company', 'planPermissions', 'planPermissions.permission'],
        orderBy: { company: { name: 'asc' }, name: 'asc' },
      }
    );

    // Un plan archivado que alguien todavía sostiene sigue concediendo
    // permisos, así que la liveness sale de las suscripciones, no del estado
    // del plan. Ver `isAuditable` en el util.
    const now = new Date();
    const liveByPlan = new Map<string, number>();
    const liveSubs = await em.find(
      Subscription,
      {
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
        currentPeriodStart: { $lte: now },
        currentPeriodEnd: { $gte: now },
      },
      { filters: false, fields: ['plan'] }
    );
    for (const sub of liveSubs) {
      const planId = sub.plan?.id;
      if (planId) liveByPlan.set(planId, (liveByPlan.get(planId) ?? 0) + 1);
    }

    const rows: PlanGrantRow[] = plans.map(plan => ({
      planId: plan.id,
      planName: plan.name,
      companyId: plan.company?.id ?? null,
      companyName: plan.company?.name ?? null,
      status: plan.status,
      isActive: plan.isActive,
      sessionCount: plan.sessionCount ?? null,
      liveSubscriptions: liveByPlan.get(plan.id) ?? 0,
      grants: plan.planPermissions
        .getItems()
        .filter(pp => pp.isActive && pp.permission.isActive)
        .map(pp => pp.permission.name),
    }));

    const report = auditPlanPermissions(rows);
    console.log(`\n${formatAuditMarkdown(report)}`);

    if (report.flagged.length > 0) {
      console.log(
        `⚠️  ${report.flagged.length} plan(es) conceden comodín o gestión: ` +
          'revísalos con el gimnasio antes de enviar la unión.'
      );
    }
  } catch (error: any) {
    console.error('❌ Error durante la auditoría:', error);
    process.exitCode = 1;
  } finally {
    await orm.close();
    console.log('🔌 Conexión a la base de datos cerrada.');
  }
}

run().catch(err => {
  console.error('❌ Error fatal en el script:', err);
  process.exitCode = 1;
});
