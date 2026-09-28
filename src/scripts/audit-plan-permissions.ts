import { MikroORM } from '@mikro-orm/core';

import { Plan } from '../entities/Plan';
import config from '../mikro-orm.config';
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
  const em = orm.em.fork();

  try {
    // La auditoría es deliberadamente cross-tenant: recorre todas las empresas
    // y nombra la de cada plan, así que desactiva el filtro companyContext.
    const plans = await em.find(
      Plan,
      {},
      {
        filters: false,
        populate: ['company', 'planPermissions', 'planPermissions.permission'],
        orderBy: { company: { name: 'asc' }, name: 'asc' },
      }
    );

    const rows: PlanGrantRow[] = plans.map(plan => ({
      planId: plan.id,
      planName: plan.name,
      companyId: plan.company?.id ?? null,
      companyName: plan.company?.name ?? null,
      status: plan.status,
      isActive: plan.isActive,
      sessionCount: plan.sessionCount ?? null,
      grants: plan.planPermissions
        .getItems()
        .filter(pp => pp.isActive && pp.permission.isActive)
        .map(pp => pp.permission.name),
    }));

    const report = auditPlanPermissions(rows);
    console.log(`\n${formatAuditMarkdown(report)}`);

    if (report.flagged.length > 0) {
      console.log(
        `⚠️  ${report.flagged.length} plan(es) conceden comodín, gestión o ` +
          'escritura: revísalos con el gimnasio antes de enviar la unión.'
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
