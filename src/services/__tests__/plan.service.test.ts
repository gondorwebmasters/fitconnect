import { Plan, PlanInterval } from '../../entities/Plan';
import { BadRequestError, BAD_REQUEST_ERRORS } from '../../utils/errors.util';
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
