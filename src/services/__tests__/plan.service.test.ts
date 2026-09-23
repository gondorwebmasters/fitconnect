import { Plan, PlanInterval, PlanStatus } from '../../entities/Plan';
import { Schedule } from '../../entities/Schedule';
import { ScheduleProgrammed } from '../../entities/ScheduleProgrammed';
import { ScheduleState } from '../../types/enums';
import {
  BadRequestError,
  BAD_REQUEST_ERRORS,
  NotFoundError,
} from '../../utils/errors.util';
import { PlanService } from '../plan.service';

/**
 * Tests del seam PlanService para Session Packs (Bonos) — issue #108.
 *
 * Prior art: subscription.service.test.ts — EntityManager mockeado, patrón
 * AAA, aserciones sobre la ServiceResponse / el error y el estado del plan
 * resultante, nunca sobre ramas internas.
 */
describe('PlanService — Session Pack (sessionCount)', () => {
  let service: PlanService;
  let mockEm: any;
  let existingPlan: any;

  function buildCreateInput(overrides: Record<string, any> = {}) {
    return {
      name: 'Bono 4 sesiones',
      amount: 4000,
      interval: PlanInterval.MONTH,
      companyId: 'comp-1',
      ...overrides,
    };
  }

  beforeEach(() => {
    existingPlan = null;

    mockEm = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === Plan) return existingPlan;
        return null;
      }),
      find: jest.fn(async () => []),
      create: jest.fn((_entity: any, data: any) => ({ ...data })),
      persist: jest.fn(),
      flush: jest.fn(async () => {}),
    };

    service = new PlanService(mockEm as any);
  });

  describe('createPlan', () => {
    it('creates a pack with sessionCount and no trial', async () => {
      const response = await service.createPlan(
        buildCreateInput({ sessionCount: 4, trialPeriodDays: 0 })
      );

      expect(response.code).toBe(201);
      const plan = (response as any).plan;
      expect(plan.sessionCount).toBe(4);
      expect(plan.trialPeriodDays ?? 0).toBe(0);
    });

    it('rejects a pack with trialPeriodDays > 0', async () => {
      await expect(
        service.createPlan(
          buildCreateInput({ sessionCount: 4, trialPeriodDays: 7 })
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.SESSION_PACK_CANNOT_HAVE_TRIAL);
    });

    it('rejects a non-positive sessionCount', async () => {
      await expect(
        service.createPlan(buildCreateInput({ sessionCount: 0 }))
      ).rejects.toThrow(BadRequestError);
    });

    it('allows a free (cash) pack', async () => {
      const response = await service.createPlan(
        buildCreateInput({ amount: 0, sessionCount: 10 })
      );

      expect(response.code).toBe(201);
      expect((response as any).plan.sessionCount).toBe(10);
      expect((response as any).plan.amount).toBe(0);
    });

    it('with sessionCount omitted behaves exactly as today (unlimited, trial allowed)', async () => {
      const response = await service.createPlan(
        buildCreateInput({ trialPeriodDays: 7 })
      );

      const plan = (response as any).plan;
      expect(response.code).toBe(201);
      expect(plan.sessionCount ?? null).toBeNull();
      expect(plan.trialPeriodDays).toBe(7);
    });
  });

  describe('updatePlan', () => {
    beforeEach(() => {
      existingPlan = {
        id: 'plan-1',
        name: 'Mensual',
        amount: 3000,
        trialPeriodDays: 7,
        sessionCount: null,
        metadata: {},
        subscriptions: [],
      };
    });

    it('turns a time-based plan into a pack when trial is cleared in the same update', async () => {
      const response = await service.updatePlan({
        id: 'plan-1',
        sessionCount: 8,
        trialPeriodDays: 0,
      });

      expect(response.code).toBe(200);
      expect(existingPlan.sessionCount).toBe(8);
      expect(existingPlan.trialPeriodDays).toBe(0);
    });

    it('rejects setting sessionCount on a plan that still has a trial', async () => {
      await expect(
        service.updatePlan({ id: 'plan-1', sessionCount: 8 })
      ).rejects.toThrow(BAD_REQUEST_ERRORS.SESSION_PACK_CANNOT_HAVE_TRIAL);
      // El plan no se ha tocado.
      expect(existingPlan.sessionCount).toBeNull();
    });

    it('rejects adding a trial to an existing pack', async () => {
      existingPlan.sessionCount = 4;
      existingPlan.trialPeriodDays = 0;

      await expect(
        service.updatePlan({ id: 'plan-1', trialPeriodDays: 5 })
      ).rejects.toThrow(BAD_REQUEST_ERRORS.SESSION_PACK_CANNOT_HAVE_TRIAL);
    });

    it('clears sessionCount with null (pack → unlimited)', async () => {
      existingPlan.sessionCount = 4;
      existingPlan.trialPeriodDays = 0;

      const response = await service.updatePlan({
        id: 'plan-1',
        sessionCount: null,
      });

      expect(response.code).toBe(200);
      expect(existingPlan.sessionCount).toBeNull();
    });

    it('does not touch existing subscriptions when editing sessionCount (snapshot)', async () => {
      existingPlan.sessionCount = 4;
      existingPlan.trialPeriodDays = 0;
      const sold = { id: 'sub-1', creditsTotal: 4, creditsUsed: 1 };
      existingPlan.subscriptions = [sold];

      await service.updatePlan({ id: 'plan-1', sessionCount: 10 });

      expect(existingPlan.sessionCount).toBe(10);
      expect(sold.creditsTotal).toBe(4);
      expect(sold.creditsUsed).toBe(1);
    });

    it('leaves sessionCount untouched when not provided', async () => {
      existingPlan.sessionCount = 4;
      existingPlan.trialPeriodDays = 0;

      await service.updatePlan({ id: 'plan-1', name: 'Bono renombrado' });

      expect(existingPlan.sessionCount).toBe(4);
      expect(existingPlan.name).toBe('Bono renombrado');
    });
  });
});

/**
 * Tests del seam PlanService para archivar un Plan que exigen horarios
 * (Restricted Schedule) — issue #13.
 *
 * La regla la fija ADR 0005: archivar **nunca** se bloquea y la restricción
 * **nunca** se retira sola; lo único que se añade es el recuento con el que se
 * avisa al administrador. Mismo patrón que el bloque de arriba: EntityManager
 * mockeado, AAA, aserciones sobre la ServiceResponse y el estado del plan.
 */
describe('PlanService — archivePlan with schedules requiring the plan', () => {
  let service: PlanService;
  let mockEm: any;
  let plan: any;
  let counts: { schedules: number; programmed: number };

  beforeEach(() => {
    counts = { schedules: 0, programmed: 0 };
    plan = {
      id: 'plan-1',
      name: 'Premium',
      status: PlanStatus.ACTIVE,
      isActive: true,
    };

    mockEm = {
      findOne: jest.fn(async (entity: any) => (entity === Plan ? plan : null)),
      count: jest.fn(async (entity: any) =>
        entity === Schedule ? counts.schedules : counts.programmed
      ),
      flush: jest.fn(async () => {}),
    };

    service = new PlanService(mockEm as any);
  });

  it('reports how many schedules and weekly templates require the plan', async () => {
    counts = { schedules: 3, programmed: 2 };

    const response: any = await service.archivePlan('plan-1');

    expect(response.requiredBySchedules).toEqual({
      scheduleCount: 3,
      scheduleProgrammedCount: 2,
      total: 5,
    });
  });

  it('archives the plan anyway — the count never refuses the archive', async () => {
    counts = { schedules: 7, programmed: 1 };

    const response = await service.archivePlan('plan-1');

    expect(response.success).toBe(true);
    expect(response.code).toBe(200);
    expect(plan.status).toBe(PlanStatus.ARCHIVED);
    expect(plan.isActive).toBe(false);
  });

  it('reports zero and archives as before when no schedule requires the plan', async () => {
    const response: any = await service.archivePlan('plan-1');

    expect(response.requiredBySchedules).toEqual({
      scheduleCount: 0,
      scheduleProgrammedCount: 0,
      total: 0,
    });
    expect(plan.status).toBe(PlanStatus.ARCHIVED);
  });

  it('never detaches the plan from the schedules that require it', async () => {
    counts = { schedules: 4, programmed: 0 };

    await service.archivePlan('plan-1');

    // Archivar solo toca el plan: no hay borrado ni actualización de los
    // pivots de allowedPlans (ADR 0005 — la restricción no se retira sola).
    expect(mockEm.nativeDelete).toBeUndefined();
    expect(mockEm.nativeUpdate).toBeUndefined();
    expect(mockEm.remove).toBeUndefined();
  });

  it('counts only schedules that are still ahead and not cancelled', async () => {
    await service.archivePlan('plan-1');

    const [entity, where] = mockEm.count.mock.calls.find(
      ([e]: any[]) => e === Schedule
    );
    expect(entity).toBe(Schedule);
    expect(where.allowedPlans).toBe('plan-1');
    expect(where.state).toEqual({ $ne: ScheduleState.CANCELLED });
    expect(where.startDate.$gte).toBeInstanceOf(Date);
  });

  it('counts the weekly templates that seed the restriction', async () => {
    counts = { schedules: 0, programmed: 2 };

    const response: any = await service.archivePlan('plan-1');

    expect(mockEm.count).toHaveBeenCalledWith(ScheduleProgrammed, {
      allowedPlans: 'plan-1',
    });
    expect(response.requiredBySchedules.scheduleProgrammedCount).toBe(2);
  });

  it('still fails when the plan does not exist', async () => {
    plan = null;

    await expect(service.archivePlan('missing')).rejects.toThrow(NotFoundError);
  });
});
