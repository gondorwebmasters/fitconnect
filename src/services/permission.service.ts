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

  constructor(em: EntityManager) {
    super(em);
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

  async getUserActiveSubscriptionInCompany(
    userId: string,
    companyId: string
  ): Promise<Subscription | null> {
    const now = moment().toDate();

    return this.em.findOne(
      Subscription,
      {
        user: userId,
        company: companyId,
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
        currentPeriodStart: { $lte: now },
        currentPeriodEnd: { $gte: now },
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

    const subscription = await this.getUserActiveSubscriptionInCompany(
      userId,
      companyId
    );
    if (!subscription) return false;

    const plan = subscription.plan;
    await plan.planPermissions.init();

    return plan.planPermissions.getItems().some(pp => {
      if (!pp.isActive || !pp.permission.isActive) return false;
      if (pp.permission.name === permissionName) return true;
      if (pp.permission.name === '*:*') return true;
      const [module] = permissionName.split(':');
      return pp.permission.name === `${module}:manage`;
    });
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

    const subscription = await this.getUserActiveSubscriptionInCompany(
      userId,
      companyId
    );
    if (!subscription) return [];

    const plan = subscription.plan;
    await plan.planPermissions.init();

    return plan.planPermissions
      .getItems()
      .filter(pp => pp.isActive && pp.permission.isActive)
      .map(pp => pp.permission);
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

    return permissionNames.every(name => {
      if (userPermissionNames.has(name)) return true;
      if (userPermissionNames.has('*:*')) return true;
      const [module] = name.split(':');
      return userPermissionNames.has(`${module}:manage`);
    });
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

    return permissionNames.some(name => {
      if (userPermissionNames.has(name)) return true;
      if (userPermissionNames.has('*:*')) return true;
      const [module] = name.split(':');
      return userPermissionNames.has(`${module}:manage`);
    });
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
      };
    }

    const subscription = await this.getUserActiveSubscriptionInCompany(
      user.id,
      companyId
    );

    if (!subscription) {
      const inactiveState = await this.resolveInactiveMemberSubscriptionState(
        user.id,
        companyId
      );

      return {
        hasActiveSubscription: false,
        subscriptionState: inactiveState.state,
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
      };
    }

    const plan = subscription.plan;
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

    for (const subscription of subscriptions) {
      const plan = subscription.plan;
      await plan.planPermissions.init();

      const permissions = plan.planPermissions
        .getItems()
        .filter(pp => pp.isActive && pp.permission.isActive)
        .map(pp => pp.permission);

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
