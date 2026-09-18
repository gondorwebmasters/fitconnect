import { EntityManager, FilterQuery, QueryOrder } from '@mikro-orm/core';

import { Plan, PlanInterval, PlanStatus } from '../entities/Plan';
import { ServiceResponse } from '../types/common.type';
import {
  BadRequestError,
  BAD_REQUEST_ERRORS,
  createServiceResponse,
  NotFoundError,
} from '../utils/errors.util';

import { BaseService } from './base.service';
import { PermissionService } from './permission.service';

export interface CreatePlanInput {
  name: string;
  description?: string;
  amount: number;
  currency?: string;
  interval: PlanInterval;
  intervalCount?: number;
  trialPeriodDays?: number;
  /** Session Pack: nº de créditos. null/undefined ⇒ ilimitado. */
  sessionCount?: number | null;
  features?: string[];
  metadata?: Record<string, any>;
  companyId?: string;
}

export interface UpdatePlanInput {
  id: string;
  name?: string;
  description?: string;
  amount?: number;
  trialPeriodDays?: number | null;
  /** Session Pack: nº de créditos. null ⇒ vuelve a ilimitado. */
  sessionCount?: number | null;
  features?: string[];
  metadata?: Record<string, any>;
  status?: PlanStatus;
  isActive?: boolean;
}

export class PlanService extends BaseService {
  private readonly permissionService: PermissionService;

  constructor(em: EntityManager) {
    super(em);
    this.permissionService = new PermissionService(em);
  }

  /**
   * Crea un nuevo plan de suscripción.
   */
  async createPlan(input: CreatePlanInput): Promise<ServiceResponse> {
    if (
      !input.name ||
      !input.interval ||
      input.amount === undefined ||
      input.amount === null
    ) {
      throw new BadRequestError('name, amount and interval are required');
    }

    if (input.amount < 0) {
      throw new BadRequestError('amount must be greater than or equal to 0');
    }

    this.assertValidSessionPack(input.sessionCount, input.trialPeriodDays);

    // Verificar nombre único por empresa
    const existing = await this.em.findOne(
      Plan,
      {
        name: input.name,
        company: input.companyId ?? null,
      },
      { filters: false }
    );

    if (existing) {
      throw new BadRequestError(
        `A plan with the name "${input.name}" already exists`
      );
    }

    const plan = this.em.create<Plan>(Plan, {
      name: input.name,
      description: input.description,
      amount: input.amount,
      currency: input.currency ?? 'eur',
      interval: input.interval,
      intervalCount: input.intervalCount ?? 1,
      trialPeriodDays: input.trialPeriodDays,
      sessionCount: input.sessionCount ?? null,
      features: input.features,
      metadata: input.metadata,
      company: input.companyId,
      status: PlanStatus.ACTIVE,
      isActive: true,
    });

    this.em.persist(plan);
    await this.em.flush();

    // Sincronizar permisos si vienen en metadata
    if (input.metadata?.permissions) {
      await this.permissionService.syncPermissionsFromMetadata(
        plan.id,
        input.metadata
      );
    }

    return createServiceResponse(201, 'Plan created successfully', true, {
      plan,
    });
  }

  /**
   * Actualiza un plan existente.
   *
   * Nota: cambiar el `amount` de un plan no afecta a las suscripciones activas
   * — estas siguen con el precio original hasta que se renueven o se migren
   * explícitamente. Implementa esa lógica en SubscriptionService si la necesitas.
   * Lo mismo aplica a `sessionCount`: los créditos se snapshotean en la
   * suscripción al crearla, así que editar el plan nunca altera packs ya vendidos.
   */
  async updatePlan(input: UpdatePlanInput): Promise<ServiceResponse> {
    if (!input.id) {
      throw new BadRequestError('Plan ID is required');
    }

    const plan = await this.em.findOne(
      Plan,
      { id: input.id },
      { filters: false, populate: ['company'] }
    );
    if (!plan) {
      throw new NotFoundError('Plan');
    }

    // Validar la combinación resultante (no solo lo que viene en el input)
    // antes de mutar nada, para que un rechazo deje el plan intacto.
    const nextSessionCount =
      input.sessionCount !== undefined ? input.sessionCount : plan.sessionCount;
    const nextTrialDays =
      input.trialPeriodDays !== undefined
        ? input.trialPeriodDays
        : plan.trialPeriodDays;
    this.assertValidSessionPack(nextSessionCount, nextTrialDays);

    if (input.name !== undefined) plan.name = input.name;
    if (input.description !== undefined) plan.description = input.description;
    if (input.amount !== undefined) {
      if (input.amount < 0)
        throw new BadRequestError('amount must be greater than or equal to 0');
      plan.amount = input.amount;
    }
    if (input.trialPeriodDays !== undefined) {
      plan.trialPeriodDays = input.trialPeriodDays ?? undefined;
    }
    if (input.sessionCount !== undefined) {
      plan.sessionCount = input.sessionCount;
    }
    if (input.features !== undefined) plan.features = input.features;
    if (input.metadata !== undefined) {
      plan.metadata = { ...plan.metadata, ...input.metadata };
    }
    if (input.status !== undefined) {
      plan.status = input.status;
      plan.isActive = input.status === PlanStatus.ACTIVE;
    }
    if (input.isActive !== undefined) {
      plan.isActive = input.isActive;
      if (!input.isActive && plan.status === PlanStatus.ACTIVE) {
        plan.status = PlanStatus.INACTIVE;
      }
    }

    await this.em.flush();

    // Sincronizar permisos si cambiaron en metadata
    if (input.metadata?.permissions) {
      await this.permissionService.syncPermissionsFromMetadata(
        plan.id,
        input.metadata
      );
    }

    return createServiceResponse(200, 'Plan updated successfully', true, {
      plan,
    });
  }

  /**
   * Reglas de un Session Pack (ver CONTEXT.md):
   *  - `sessionCount`, si está informado, es un entero > 0.
   *  - Un pack nunca lleva trial.
   * Con `sessionCount` null/undefined no se aplica ninguna regla nueva.
   */
  private assertValidSessionPack(
    sessionCount: number | null | undefined,
    trialPeriodDays: number | null | undefined
  ): void {
    if (sessionCount === null || sessionCount === undefined) return;

    if (!Number.isInteger(sessionCount) || sessionCount <= 0) {
      throw new BadRequestError(
        BAD_REQUEST_ERRORS.SESSION_COUNT_MUST_BE_POSITIVE
      );
    }
    if ((trialPeriodDays ?? 0) > 0) {
      throw new BadRequestError(
        BAD_REQUEST_ERRORS.SESSION_PACK_CANNOT_HAVE_TRIAL
      );
    }
  }

  /**
   * Obtiene un plan por su ID.
   */
  async getPlan(planId: string): Promise<ServiceResponse> {
    if (!planId) {
      throw new BadRequestError('Plan ID is required');
    }

    const plan = await this.em.findOne(
      Plan,
      { id: planId },
      {
        filters: false,
        populate: [
          'planPermissions',
          'planPermissions.permission',
          'company',
          'subscriptions',
          'subscriptions.user',
        ],
      }
    );

    if (!plan) {
      throw new NotFoundError('Plan');
    }

    return createServiceResponse(200, 'Plan fetched successfully', true, {
      plan,
    });
  }

  /**
   * Lista planes con filtros opcionales.
   */
  async listPlans(
    onlyActive: boolean = true,
    showGlobal: boolean = false
  ): Promise<ServiceResponse> {
    const where: FilterQuery<Plan> = onlyActive
      ? { status: PlanStatus.ACTIVE }
      : {};

    if (showGlobal) {
      where.company = null;
    }

    const plans = await this.em.find<Plan>(Plan, where, {
      orderBy: { amount: QueryOrder.ASC },
      populate: ['subscriptions', 'company'] as any,
      filters: !showGlobal,
    });

    return createServiceResponse(200, 'Plans fetched successfully', true, {
      plans,
    });
  }

  /**
   * Desactiva un plan. Las suscripciones activas no se ven afectadas
   * hasta su próxima renovación, momento en que deberían migrarse o cancelarse.
   */
  async deactivatePlan(planId: string): Promise<ServiceResponse> {
    const plan = await this.em.findOne(
      Plan,
      { id: planId },
      { filters: false, populate: ['company'] }
    );
    if (!plan) {
      throw new NotFoundError('Plan');
    }

    plan.isActive = false;
    plan.status = PlanStatus.INACTIVE;
    await this.em.flush();

    return createServiceResponse(200, 'Plan deactivated successfully', true, {
      plan,
    });
  }

  /**
   * Archiva un plan de forma permanente.
   * Un plan archivado no puede reactivarse — crear uno nuevo si es necesario.
   */
  async archivePlan(planId: string): Promise<ServiceResponse> {
    const plan = await this.em.findOne(
      Plan,
      { id: planId },
      { filters: false, populate: ['company'] }
    );
    if (!plan) {
      throw new NotFoundError('Plan');
    }

    plan.isActive = false;
    plan.status = PlanStatus.ARCHIVED;
    await this.em.flush();

    return createServiceResponse(200, 'Plan archived successfully', true, {
      plan,
    });
  }

  /**
   * Obtiene el plan activo vinculado a una empresa.
   * Útil para contextos multi-tenant donde cada empresa puede tener planes propios.
   */
  async getPlansByCompany(companyId: string): Promise<ServiceResponse> {
    /* if (!companyId) {
      throw new BadRequestError('Company ID is required');
    }*/

    const plans = await this.em.find<Plan>(
      Plan,
      { company: companyId, status: PlanStatus.ACTIVE },
      {
        orderBy: { amount: QueryOrder.ASC },
        filters: false,
      }
    );

    return createServiceResponse(200, 'Plans fetched successfully', true, {
      plans,
    });
  }
}
