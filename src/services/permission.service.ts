import { EntityManager } from '@mikro-orm/core';
import moment from 'moment';

import {
  Permission,
  PermissionAction,
  PermissionModule,
} from '../entities/Permission';
import { Plan } from '../entities/Plan';
import { PlanPermission } from '../entities/PlanPermission';
import {
  Subscription,
  SubscriptionAccessState,
  SubscriptionStatus,
} from '../entities/Subscription';
import { User } from '../entities/User';
import { UserRole } from '../entities/UserRole';
import { Currency, UserRoleEnum } from '../types/enums';
import {
  CompanyPermissionsContext,
  LoginPermissionsContext,
} from '../types/permissions';

import { BaseService } from './base.service';
import {
  aggregateSubscriptionState,
  EntitlementService,
} from './entitlement.service';

interface CreatePermissionInput {
  module: PermissionModule;
  action: PermissionAction;
  description?: string;
}

export class PermissionService extends BaseService {
  public readonly coachPermissionNames = [
    'schedules:manage',
    'workouts:manage',
    'chats:manage',
    'polls:manage',
    'user_weights:manage',
    'users:read',
  ];

  private readonly entitlement: EntitlementService;

  constructor(em: EntityManager) {
    super(em);
    this.entitlement = new EntitlementService(em);
  }

  // ─────────────────────────────────────────────
  // SUSCRIPCIÓN ACTIVA DE ADMIN
  // ─────────────────────────────────────────────

  async getCompanyActiveAdminSubscription(
    companyId: string
  ): Promise<Subscription | null> {
    const adminRoles = await this.em.find(
      UserRole,
      { company: companyId, role: UserRoleEnum.ADMIN },
      { fields: ['user'] as any, filters: { companyContext: false } }
    );

    const adminUserIds = adminRoles.map(r => r.user.id);
    if (adminUserIds.length === 0) return null;

    return this.em.findOne(
      Subscription,
      {
        company: companyId,
        user: { $in: adminUserIds },
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
      {
        populate: [
          'plan',
          'plan.planPermissions',
          'plan.planPermissions.permission',
          'plan.name',
        ],
        filters: false,
      }
    );
  }

  // ─────────────────────────────────────────────
  // CRUD DE PERMISOS
  // ─────────────────────────────────────────────

  async createPermission(input: CreatePermissionInput): Promise<Permission> {
    const name = Permission.generateName(input.module, input.action);
    let permission = await this.em.findOne(Permission, { name });

    if (permission) {
      permission.description = input.description || permission.description;
      permission.isActive = true;
    } else {
      permission = this.em.create<Permission>(Permission, {
        name,
        module: input.module,
        action: input.action,
        description: input.description,
      });
      this.em.persist(permission);
    }

    await this.em.flush();
    return permission;
  }

  async assignPermissionsToPlan(
    planId: string,
    permissionNames: string[]
  ): Promise<void> {
    const plan = await this.em.findOne(
      Plan,
      { id: planId },
      {
        populate: ['planPermissions', 'planPermissions.permission'],
        filters: false,
      }
    );

    if (!plan) throw new Error('Plan not found');

    const permissions = await this.em.find(Permission, {
      name: { $in: permissionNames },
      isActive: true,
    });

    if (permissions.length !== permissionNames.length) {
      const foundNames = new Set(permissions.map(p => p.name));
      const missing = permissionNames.filter(name => !foundNames.has(name));
      console.warn(`Some permissions not found: ${missing.join(', ')}`);
    }

    const currentPlanPermissions = plan.planPermissions.getItems();

    for (const pp of currentPlanPermissions) {
      if (!permissionNames.includes(pp.permission.name)) {
        pp.isActive = false;
      }
    }

    for (const permission of permissions) {
      const existing: PlanPermission | undefined = currentPlanPermissions.find(
        (pp: PlanPermission) => pp.permission.id === permission.id
      );

      if (existing) {
        existing.isActive = true;
      } else {
        const planPermission = this.em.create<PlanPermission>(PlanPermission, {
          plan,
          permission,
          isActive: true,
        });
        this.em.persist(planPermission);
      }
    }

    await this.em.flush();
  }

  async syncPermissionsFromMetadata(
    planId: string,
    metadata: Record<string, any>
  ): Promise<void> {
    if (!metadata?.permissions) {
      console.log(`No permissions found in metadata for plan ${planId}`);
      return;
    }

    const permissionNames = metadata.permissions
      .split(',')
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0);

    if (permissionNames.length === 0) {
      console.log(`Empty permissions list for plan ${planId}`);
      return;
    }

    await this.assignPermissionsToPlan(planId, permissionNames);
    console.log(
      `Synced ${permissionNames.length} permissions for plan ${planId}`
    );
  }

  // ─────────────────────────────────────────────
  // CONSULTAS POR EMPRESA
  // ─────────────────────────────────────────────

  async getUserActivePlanInCompany(
    userId: string,
    companyId: string
  ): Promise<Plan | null> {
    const subscription = await this.em.findOne(
      Subscription,
      {
        user: userId,
        company: companyId,
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
      { populate: ['plan'] as any }
    );

    return subscription?.plan || null;
  }

  /**
   * La suscripción vigente del miembro en la empresa, con su plan y los
   * permisos del plan ya populados.
   *
   * @remarks Delega en {@link EntitlementService}, el único dueño de la
   * pregunta (ADR 0006): aquí no vive ninguna consulta propia.
   */
  async getUserActiveSubscriptionInCompany(
    userId: string,
    companyId: string
  ): Promise<Subscription | null> {
    return this.entitlement.findLiveSubscription(userId, companyId, {
      populate: [
        'plan',
        'plan.planPermissions',
        'plan.planPermissions.permission',
        'plan.name',
      ],
    });
  }

  /**
   * El Entitlement del miembro: **todas** sus suscripciones vigentes en la
   * empresa, con plan y permisos del plan populados.
   *
   * @remarks Delega en {@link EntitlementService}, el único dueño de la
   * pregunta (ADR 0006). Es el punto de partida de la unión de permisos.
   *
   * @param userId - Miembro cuyo Entitlement se consulta.
   * @param companyId - Empresa en la que se consulta.
   * @returns Las suscripciones vigentes; vacío si el Entitlement está vacío.
   */
  async getUserEntitlementInCompany(
    userId: string,
    companyId: string
  ): Promise<Subscription[]> {
    return this.entitlement.findLiveSubscriptions(userId, companyId, {
      populate: [
        'plan',
        'plan.planPermissions',
        'plan.planPermissions.permission',
        'plan.name',
      ],
    });
  }

  // ─────────────────────────────────────────────
  // UNIÓN DE PERMISOS DEL ENTITLEMENT
  // ─────────────────────────────────────────────

  /**
   * Los permisos que un plan concede de verdad: los que están activos en ambos
   * lados de `PlanPermission`.
   *
   * @param plan - Plan con `planPermissions` ya populado o inicializado.
   * @returns Los permisos concedidos por el plan.
   */
  private activePermissionsOfPlan(plan: Plan): Permission[] {
    return plan.planPermissions
      .getItems()
      .filter(pp => pp.isActive && pp.permission.isActive)
      .map(pp => pp.permission);
  }

  /**
   * La **unión** de los permisos de los planes de un Entitlement (ADR 0006,
   * decisión 3): un plan nunca puede *quitar* acceso que otro concede.
   *
   * @remarks Sin intersección, sin precedencia y sin permisos negativos — es la
   * decisión del ADR, no una simplificación pendiente. Por eso el orden del
   * conjunto es irrelevante y el resultado no depende de él.
   *
   * Se deduplica por **nombre**: dos planes que conceden `schedules:read` lo
   * reportan una vez. Con una sola suscripción el resultado es exactamente el
   * de antes de la unión.
   *
   * @param subscriptions - El Entitlement, con los planes ya populados.
   * @returns Los permisos concedidos por algún plan del conjunto.
   */
  private async unitePlanPermissions(
    subscriptions: Subscription[]
  ): Promise<Permission[]> {
    const byName = new Map<string, Permission>();

    for (const subscription of subscriptions) {
      const plan = subscription.plan;
      await plan.planPermissions.init();

      for (const permission of this.activePermissionsOfPlan(plan)) {
        if (!byName.has(permission.name))
          byName.set(permission.name, permission);
      }
    }

    return [...byName.values()];
  }

  /**
   * Si un conjunto de permisos concedidos cubre el permiso pedido.
   *
   * @remarks Las tres ramas de siempre, en un solo sitio: nombre exacto, el
   * comodín `*:*`, y `<módulo>:manage`, que implica cualquier acción de su
   * módulo. La unión no cambia cómo resuelven — solo de dónde sale el conjunto.
   *
   * @param grantedNames - Nombres de los permisos concedidos.
   * @param permissionName - Permiso pedido, p. ej. `schedules:read`.
   * @returns Si el conjunto concedido cubre el permiso pedido.
   */
  private grantsPermission(
    grantedNames: Set<string>,
    permissionName: string
  ): boolean {
    if (grantedNames.has(permissionName)) return true;
    if (grantedNames.has('*:*')) return true;
    const [module] = permissionName.split(':');
    return grantedNames.has(`${module}:manage`);
  }

  /**
   * Resuelve el estado de acceso de un miembro **sin** suscripción vigente en la
   * empresa: distingue entre SCHEDULED (tiene una Suscripción Futura que aún no
   * empieza), EXPIRED (tuvo alguna y ya no) y NONE (nunca tuvo).
   *
   * SCHEDULED tiene prioridad sobre EXPIRED: si existe una futura, es el mensaje
   * útil aunque también existan suscripciones pasadas.
   */
  async resolveInactiveMemberSubscriptionState(
    userId: string,
    companyId: string
  ): Promise<{
    state: SubscriptionAccessState;
    startDate: Date | null;
    endDate: Date | null;
  }> {
    const now = moment().toDate();

    // 1) ¿Suscripción futura (aún no empezada) ACTIVE/TRIALING? -> SCHEDULED
    const futureSubscription = await this.em.findOne(
      Subscription,
      {
        user: userId,
        company: companyId,
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
        currentPeriodStart: { $gt: now },
      },
      { orderBy: { currentPeriodStart: 'ASC' }, filters: false }
    );

    if (futureSubscription) {
      return {
        state: SubscriptionAccessState.SCHEDULED,
        startDate:
          futureSubscription.currentPeriodStart ||
          futureSubscription.trialStart ||
          null,
        endDate:
          futureSubscription.currentPeriodEnd ||
          futureSubscription.trialEnd ||
          null,
      };
    }

    // 2) ¿Existe alguna suscripción pasada? -> EXPIRED (con la fecha de fin más reciente)
    const lastExpiredSubscription = await this.em.findOne(
      Subscription,
      { user: userId, company: companyId },
      { orderBy: { currentPeriodEnd: 'DESC' }, filters: false }
    );

    if (lastExpiredSubscription) {
      return {
        state: SubscriptionAccessState.EXPIRED,
        startDate: null,
        endDate:
          lastExpiredSubscription.currentPeriodEnd ||
          lastExpiredSubscription.endedAt ||
          lastExpiredSubscription.trialEnd ||
          null,
      };
    }

    // 3) Nunca tuvo suscripción -> NONE
    return {
      state: SubscriptionAccessState.NONE,
      startDate: null,
      endDate: null,
    };
  }

  async userHasPermissionInCompany(
    userId: string,
    permissionName: string,
    companyId: string
  ): Promise<boolean> {
    const userRole = await this.em.findOne(UserRole, {
      user: userId,
      company: companyId,
    });

    if (userRole?.role === UserRoleEnum.COACH) {
      if (this.coachPermissionNames.includes(permissionName)) return true;
      const [module] = permissionName.split(':');
      return this.coachPermissionNames.includes(`${module}:manage`);
    }

    if (userRole?.role === UserRoleEnum.ADMIN) {
      const adminSubscription =
        await this.getCompanyActiveAdminSubscription(companyId);
      if (!adminSubscription) return false;

      const plan = adminSubscription.plan;
      await plan.planPermissions.init();

      return plan.planPermissions.getItems().some(pp => {
        if (!pp.isActive || !pp.permission.isActive) return false;
        if (pp.permission.name === permissionName) return true;
        if (pp.permission.name === '*:*') return true;
        const [module] = permissionName.split(':');
        return pp.permission.name === `${module}:manage`;
      });
    }

    const entitlement = await this.getUserEntitlementInCompany(
      userId,
      companyId
    );
    if (entitlement.length === 0) return false;

    const granted = await this.unitePlanPermissions(entitlement);

    return this.grantsPermission(
      new Set(granted.map(p => p.name)),
      permissionName
    );
  }

  async getUserPermissionsInCompany(
    userId: string,
    companyId: string
  ): Promise<Permission[]> {
    const userRole = await this.em.findOne(UserRole, {
      user: userId,
      company: companyId,
    });

    if (userRole?.role === UserRoleEnum.COACH) {
      return this.em.find(Permission, {
        name: { $in: this.coachPermissionNames },
        isActive: true,
      });
    }

    if (userRole?.role === UserRoleEnum.ADMIN) {
      const adminSubscription =
        await this.getCompanyActiveAdminSubscription(companyId);
      if (!adminSubscription) return [];

      const plan = adminSubscription.plan;
      await plan.planPermissions.init();

      return plan.planPermissions
        .getItems()
        .filter(pp => pp.isActive && pp.permission.isActive)
        .map(pp => pp.permission);
    }

    const entitlement = await this.getUserEntitlementInCompany(
      userId,
      companyId
    );

    return this.unitePlanPermissions(entitlement);
  }

  async getUserActiveSubscriptions(userId: string): Promise<Subscription[]> {
    return this.em.find(
      Subscription,
      {
        user: userId,
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
      {
        populate: [
          'plan',
          'company',
          'plan.planPermissions',
          'plan.planPermissions.permission',
        ],
      }
    );
  }

  async userHasAllPermissions(
    userId: string,
    permissionNames: string[],
    companyId: string
  ): Promise<boolean> {
    const userPermissions = await this.getUserPermissionsInCompany(
      userId,
      companyId
    );
    const userPermissionNames = new Set(userPermissions.map(p => p.name));

    return permissionNames.every(name =>
      this.grantsPermission(userPermissionNames, name)
    );
  }

  async userHasAnyPermission(
    userId: string,
    permissionNames: string[],
    companyId: string
  ): Promise<boolean> {
    const userPermissions = await this.getUserPermissionsInCompany(
      userId,
      companyId
    );
    const userPermissionNames = new Set(userPermissions.map(p => p.name));

    return permissionNames.some(name =>
      this.grantsPermission(userPermissionNames, name)
    );
  }

  /** @deprecated Use userHasPermissionInCompany */
  async userHasPermission(
    userId: string,
    permissionName: string,
    companyId?: string
  ): Promise<boolean> {
    if (!companyId) {
      console.warn('userHasPermission called without companyId.');
      return false;
    }
    return this.userHasPermissionInCompany(userId, permissionName, companyId);
  }

  // ─────────────────────────────────────────────
  // ADMINISTRACIÓN
  // ─────────────────────────────────────────────

  async listAllPermissions(): Promise<Permission[]> {
    return this.em.find(Permission, { isActive: true });
  }

  async getPermissionsByModule(): Promise<Map<PermissionModule, Permission[]>> {
    const permissions = await this.listAllPermissions();
    const grouped = new Map<PermissionModule, Permission[]>();

    for (const permission of permissions) {
      if (!grouped.has(permission.module)) {
        grouped.set(permission.module, []);
      }
      grouped.get(permission.module)!.push(permission);
    }

    return grouped;
  }

  async getPlanPermissions(planId: string): Promise<Permission[]> {
    const plan = await this.em.findOne(
      Plan,
      { id: planId },
      { populate: ['planPermissions', 'planPermissions.permission'] }
    );

    if (!plan) throw new Error('Plan not found');

    return plan.planPermissions
      .getItems()
      .filter((pp: PlanPermission) => pp.isActive && pp.permission.isActive)
      .map((pp: PlanPermission) => pp.permission);
  }

  async planHasPermission(
    planId: string,
    permissionName: string
  ): Promise<boolean> {
    const permissions = await this.getPlanPermissions(planId);
    return permissions.some(p => p.name === permissionName);
  }

  async seedPermissions(): Promise<void> {
    const modules = Object.values(PermissionModule) as PermissionModule[];
    const actions = Object.values(PermissionAction) as PermissionAction[];

    for (const module of modules) {
      for (const action of actions) {
        await this.createPermission({
          module,
          action,
          description: `${action} permission for ${module} module`,
        });
      }
    }

    console.log('Permissions seeded successfully');
  }

  async syncMissingPermissions(): Promise<void> {
    const modules = Object.values(PermissionModule) as PermissionModule[];
    const actions = Object.values(PermissionAction) as PermissionAction[];

    for (const module of modules) {
      for (const action of actions) {
        const name = Permission.generateName(module, action);
        const exists = await this.em.count(Permission, { name });

        if (exists === 0) {
          const permission = this.em.create<Permission>(Permission, {
            name,
            module,
            action,
            description: `${action} permission for ${module} module`,
          });
          this.em.persist(permission);
        }
      }
    }

    await this.em.flush();
    console.log('Missing permissions synchronized successfully');
  }

  async deactivatePermission(permissionId: string): Promise<void> {
    const permission = await this.em.findOne(Permission, { id: permissionId });
    if (!permission) throw new Error('Permission not found');

    permission.isActive = false;
    await this.em.flush();
    console.log(`Permission ${permission.name} deactivated`);
  }

  async activatePermission(permissionId: string): Promise<void> {
    const permission = await this.em.findOne(Permission, { id: permissionId });
    if (!permission) throw new Error('Permission not found');

    permission.isActive = true;
    await this.em.flush();
    console.log(`Permission ${permission.name} activated`);
  }

  // ─────────────────────────────────────────────
  // CONTEXTO DE LOGIN
  // ─────────────────────────────────────────────

  async getLoginPermissionsContext(
    user: User,
    companyId: string
  ): Promise<LoginPermissionsContext> {
    if (user.isSuperAdmin) {
      return {
        hasActiveSubscription: false,
        subscriptionState: SubscriptionAccessState.NONE,
        plan: null,
        permissions: [],
        permissionNames: ['*:*'],
        subscriptionStatus: null,
        trialEndsAt: null,
        renewsAt: null,
        startDate: null,
        endDate: null,
        cancelAtPeriodEnd: null,
        remainingCredits: null,
        creditsTotal: null,
      };
    }

    const userRole = await this.em.findOne(
      UserRole,
      { user: user.id, company: companyId },
      { filters: { companyContext: false } }
    );

    if (userRole?.role === UserRoleEnum.COACH) {
      const permissions = await this.em.find(Permission, {
        name: { $in: this.coachPermissionNames },
        isActive: true,
      });

      return {
        hasActiveSubscription: true,
        subscriptionState: SubscriptionAccessState.ACTIVE,
        plan: {
          id: 'coach-free-plan',
          name: 'Plan de Entrenador',
          amount: 0,
          currency: Currency.EUR,
          interval: 'lifetime',
        } as any,
        permissions,
        permissionNames: this.coachPermissionNames,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        subscriptionId: 'coach-free-sub',
        trialEndsAt: null,
        renewsAt: null,
        isInTrial: false,
        startDate: null,
        endDate: null,
        cancelAtPeriodEnd: null,
        remainingCredits: null,
        creditsTotal: null,
      };
    }

    if (userRole?.role === UserRoleEnum.ADMIN) {
      const adminSubscription =
        await this.getCompanyActiveAdminSubscription(companyId);

      if (!adminSubscription) {
        return {
          hasActiveSubscription: false,
          subscriptionState: SubscriptionAccessState.NONE,
          plan: null,
          permissions: [],
          permissionNames: [],
          subscriptionStatus: null,
          trialEndsAt: null,
          renewsAt: null,
          startDate: null,
          endDate: null,
          cancelAtPeriodEnd: null,
          remainingCredits: null,
          creditsTotal: null,
        };
      }

      const plan = adminSubscription.plan;
      const permissions = plan.planPermissions
        .getItems()
        .filter(pp => pp.isActive && pp.permission.isActive)
        .map(pp => pp.permission);

      return {
        hasActiveSubscription: true,
        plan: {
          id: plan.id,
          name: plan.name,
          amount: plan.amount,
          currency: plan.currency,
          interval: plan.interval,
        },
        subscriptionState: SubscriptionAccessState.ACTIVE,
        permissions,
        permissionNames: permissions.map(p => p.name),
        subscriptionStatus: adminSubscription.status,
        subscriptionId: adminSubscription.id,
        trialEndsAt: adminSubscription.trialEnd,
        renewsAt: adminSubscription.currentPeriodEnd,
        isInTrial: adminSubscription.isInTrial,
        startDate:
          adminSubscription.currentPeriodStart ||
          adminSubscription.trialStart ||
          null,
        endDate:
          adminSubscription.currentPeriodEnd ||
          adminSubscription.trialEnd ||
          null,
        cancelAtPeriodEnd: adminSubscription.cancelAtPeriodEnd ?? null,
        remainingCredits: adminSubscription.remainingCredits,
        creditsTotal: adminSubscription.creditsTotal ?? null,
      };
    }

    const entitlement = await this.getUserEntitlementInCompany(
      user.id,
      companyId
    );
    // Los escalares del payload siguen siendo singulares y deprecados: su
    // resolución determinista sobre el conjunto es trabajo del issue #20. Aquí
    // solo los permisos pasan a ser la unión.
    const [subscription] = entitlement;

    // `hasActive` y `subscriptionState` se leen sobre el **conjunto**, no sobre
    // "la" suscripción (ADR 0006, decisiones 4 y 10): acceso general mientras el
    // Entitlement no esté vacío, y `ACTIVE` por encima de cualquier estado que
    // dejen las no vigentes — vigente en un plan y caducado en otro es `ACTIVE`.
    if (entitlement.length === 0) {
      const inactiveState = await this.resolveInactiveMemberSubscriptionState(
        user.id,
        companyId
      );

      return {
        hasActiveSubscription: false,
        subscriptionState: aggregateSubscriptionState(
          entitlement,
          inactiveState.state
        ),
        plan: null,
        permissions: [],
        permissionNames: [],
        subscriptionStatus: null,
        trialEndsAt: null,
        renewsAt: null,
        startDate: inactiveState.startDate,
        endDate: inactiveState.endDate,
        cancelAtPeriodEnd: null,
        remainingCredits: null,
        creditsTotal: null,
      };
    }

    const plan = subscription.plan;
    const permissions = await this.unitePlanPermissions(entitlement);

    return {
      hasActiveSubscription: entitlement.length > 0,
      plan: {
        id: plan.id,
        name: plan.name,
        amount: plan.amount,
        currency: plan.currency,
        interval: plan.interval,
      },
      subscriptionState: aggregateSubscriptionState(
        entitlement,
        SubscriptionAccessState.NONE
      ),
      permissions,
      permissionNames: permissions.map(p => p.name),
      subscriptionStatus: subscription.status,
      subscriptionId: subscription.id,
      trialEndsAt: subscription.trialEnd,
      renewsAt: subscription.currentPeriodEnd,
      isInTrial: subscription.isInTrial,
      startDate:
        subscription.currentPeriodStart || subscription.trialStart || null,
      endDate: subscription.currentPeriodEnd || subscription.trialEnd || null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? null,
      remainingCredits: subscription.remainingCredits,
      creditsTotal: subscription.creditsTotal ?? null,
    };
  }

  async getLoginPermissionNames(
    user: User,
    companyId: string
  ): Promise<string[]> {
    const context = await this.getLoginPermissionsContext(user, companyId);
    return context.permissionNames;
  }

  async getUserCompaniesWithPermissions(
    userId: string
  ): Promise<CompanyPermissionsContext[]> {
    const subscriptions = await this.getUserActiveSubscriptions(userId);
    const companiesContext: CompanyPermissionsContext[] = [];

    // Una entrada por empresa, no por suscripción: el Entitlement del miembro
    // en esa empresa es el conjunto, y sus permisos son la unión (ADR 0006).
    // La unión nunca cruza empresas — un plan de un gimnasio no concede nada en
    // otro.
    const byCompany = new Map<string, Subscription[]>();
    for (const subscription of subscriptions) {
      const companyId = subscription.company.id;
      const soFar = byCompany.get(companyId) ?? [];
      soFar.push(subscription);
      byCompany.set(companyId, soFar);
    }

    for (const companySubscriptions of byCompany.values()) {
      const permissions = await this.unitePlanPermissions(companySubscriptions);
      // Los campos singulares (plan, estado, renovación) los resuelve el issue
      // #20; hasta entonces son los de una suscripción del conjunto, como hoy.
      const subscription = companySubscriptions[0];
      const plan = subscription.plan;

      companiesContext.push({
        companyId: subscription.company.id,
        companyName: subscription.company.name,
        plan: {
          id: plan.id,
          name: plan.name,
          amount: plan.amount,
          currency: plan.currency,
        },
        permissions: permissions.map(p => p.name),
        subscriptionStatus: subscription.status,
        isInTrial: subscription.isInTrial,
        trialEndsAt: subscription.trialEnd,
        renewsAt: subscription.currentPeriodEnd,
      });
    }

    // Roles COACH
    const coachRoles = await this.em.find(
      UserRole,
      { user: userId, role: UserRoleEnum.COACH },
      { populate: ['company'] }
    );

    for (const coachRole of coachRoles) {
      const company = coachRole.company;
      if (companiesContext.some(c => c.companyId === company.id)) continue;

      companiesContext.push({
        companyId: company.id,
        companyName: company.name,
        plan: {
          id: 'coach-free-plan',
          name: 'Plan de Entrenador',
          amount: 0,
          currency: Currency.EUR,
        } as any,
        permissions: this.coachPermissionNames,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        isInTrial: false,
        trialEndsAt: undefined,
        renewsAt: undefined,
      });
    }

    // Roles ADMIN
    const adminRoles = await this.em.find(
      UserRole,
      { user: userId, role: UserRoleEnum.ADMIN },
      { populate: ['company'] }
    );

    for (const adminRole of adminRoles) {
      const company = adminRole.company;
      if (companiesContext.some(c => c.companyId === company.id)) continue;

      const adminSubscription = await this.getCompanyActiveAdminSubscription(
        company.id
      );
      if (!adminSubscription) continue;

      const plan = adminSubscription.plan;
      await plan.planPermissions.init();

      const permissions = plan.planPermissions
        .getItems()
        .filter(pp => pp.isActive && pp.permission.isActive)
        .map(pp => pp.permission);

      companiesContext.push({
        companyId: company.id,
        companyName: company.name,
        plan: {
          id: plan.id,
          name: plan.name,
          amount: plan.amount,
          currency: plan.currency,
        },
        permissions: permissions.map(p => p.name),
        subscriptionStatus: adminSubscription.status,
        isInTrial: adminSubscription.isInTrial,
        trialEndsAt: adminSubscription.trialEnd,
        renewsAt: adminSubscription.currentPeriodEnd,
      });
    }

    return companiesContext;
  }
}
