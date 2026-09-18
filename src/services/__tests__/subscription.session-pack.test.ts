import moment from 'moment';

import { Plan, PlanInterval } from '../../entities/Plan';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { BAD_REQUEST_ERRORS } from '../../utils/errors.util';
import { SubscriptionService } from '../subscription.service';

/**
 * Tests del seam SubscriptionService para Session Packs (Bonos) — issue #108.
 *
 * Cubre el snapshot de créditos en createSubscription (rutas desde cero,
 * futura y retroactiva) y el rechazo de changePlan hacia/desde un pack.
 * Prior art: subscription.service.test.ts (EM + procesador de pago mockeados).
 */
describe('SubscriptionService — Session Pack', () => {
  let service: SubscriptionService;
  let mockEm: any;
  let user: User;
  let currentPlan: any;
  let existingSubs: any[];

  const PACK_PLAN: any = {
    id: 'plan-pack',
    amount: 0,
    interval: PlanInterval.MONTH,
    intervalCount: 1,
    currency: 'eur',
    name: 'Bono 4 sesiones',
    trialPeriodDays: 0,
    sessionCount: 4,
    isActive: true,
    company: { id: 'comp-1' },
  };

  const TIME_PLAN: any = {
    id: 'plan-time',
    amount: 0,
    interval: PlanInterval.MONTH,
    intervalCount: 1,
    currency: 'eur',
    name: 'Mensual',
    trialPeriodDays: 7,
    sessionCount: null,
    isActive: true,
    company: { id: 'comp-1' },
  };

  function buildInput(overrides: Record<string, any> = {}) {
    return {
      userId: 'user-1',
      planId: currentPlan.id,
      companyId: 'comp-1',
      ...overrides,
    };
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    existingSubs = [];
    currentPlan = PACK_PLAN;

    mockEm = {
      findOne: jest.fn(async (entity: any, where: any) => {
        if (entity === User) return user;
        if (entity === Plan) {
          if (where?.id && where.id !== currentPlan.id) {
            return [PACK_PLAN, TIME_PLAN].find(p => p.id === where.id) ?? null;
          }
          return currentPlan;
        }
        if (entity === Subscription) {
          return (
            existingSubs.find(s => !where?.id || s.id === where.id) ?? null
          );
        }
        return null;
      }),
      find: jest.fn(async (entity: any) =>
        entity === Subscription ? existingSubs : []
      ),
      create: jest.fn((_entity: any, data: any) => ({ ...data })),
      persist: jest.fn(),
      flush: jest.fn(async () => {}),
      refresh: jest.fn(async () => {}),
    };

    service = new SubscriptionService(mockEm as any, {} as any);
    (service as any).customerService.getOrCreateCustomer = jest
      .fn()
      .mockResolvedValue({ id: 'cust-1' });
  });

  describe('createSubscription — credit snapshot', () => {
    it('from scratch: copies sessionCount, creditsUsed = 0, cancelAtPeriodEnd = true, no trial', async () => {
      currentPlan = PACK_PLAN;

      const response = await service.createSubscription(
        buildInput({ trialPeriodDays: 7 })
      );

      expect(response.code).toBe(201);
      const sub = (response as any).subscription;
      expect(sub.creditsTotal).toBe(4);
      expect(sub.creditsUsed).toBe(0);
      expect(sub.cancelAtPeriodEnd).toBe(true);
      expect(sub.status).not.toBe(SubscriptionStatus.TRIALING);
      expect(sub.trialStart).toBeUndefined();
      expect(sub.trialEnd).toBeUndefined();
    });

    it('Future Subscription (active time plan, pack starting at its period end): snapshot is taken too', async () => {
      currentPlan = PACK_PLAN;
      const periodEnd = moment().add(10, 'days').startOf('day');
      const current = {
        id: 'sub-current',
        user,
        company: 'comp-1',
        plan: TIME_PLAN,
        status: SubscriptionStatus.ACTIVE,
        isActive: true,
        cancelAtPeriodEnd: false,
        currentPeriodStart: moment().subtract(20, 'days').toDate(),
        currentPeriodEnd: periodEnd.toDate(),
        metadata: { history: [] },
      };
      existingSubs = [current];

      const response = await service.createSubscription(
        buildInput({ startDate: periodEnd.toDate() })
      );

      const sub = (response as any).subscription;
      expect(response.code).toBe(201);
      expect(moment(sub.currentPeriodStart).isSame(periodEnd, 'day')).toBe(
        true
      );
      expect(sub.creditsTotal).toBe(4);
      expect(sub.creditsUsed).toBe(0);
      expect(sub.cancelAtPeriodEnd).toBe(true);
      // La actual queda marcada para no renovarse (comportamiento existente).
      expect(current.cancelAtPeriodEnd).toBe(true);
    });

    it('backdated (cash) subscription: snapshot is taken too', async () => {
      currentPlan = PACK_PLAN;
      const backdated = moment().subtract(5, 'days').startOf('day');

      const response = await service.createSubscription(
        buildInput({ startDate: backdated.toDate() })
      );

      const sub = (response as any).subscription;
      expect(response.code).toBe(201);
      expect(sub.metadata.backdated).toBe(true);
      expect(sub.creditsTotal).toBe(4);
      expect(sub.creditsUsed).toBe(0);
      expect(sub.cancelAtPeriodEnd).toBe(true);
    });

    it('time-based plan: creditsTotal is null (unlimited) and trial still applies', async () => {
      currentPlan = TIME_PLAN;

      const response = await service.createSubscription(buildInput());

      const sub = (response as any).subscription;
      expect(sub.creditsTotal).toBeNull();
      expect(sub.creditsUsed).toBe(0);
      expect(sub.status).toBe(SubscriptionStatus.TRIALING);
    });
  });

  describe('reactivateSubscription — packs are single-use', () => {
    it('rejects reactivating a CANCELED pack', async () => {
      existingSubs = [
        {
          id: 'sub-1',
          user,
          company: 'comp-1',
          plan: PACK_PLAN,
          status: SubscriptionStatus.CANCELED,
          creditsTotal: 4,
          creditsUsed: 4,
          cancelAtPeriodEnd: true,
          metadata: { history: [] },
        },
      ];

      await expect(service.reactivateSubscription('sub-1')).rejects.toThrow(
        BAD_REQUEST_ERRORS.CANNOT_REACTIVATE_SESSION_PACK
      );
      expect(existingSubs[0].status).toBe(SubscriptionStatus.CANCELED);
      expect(existingSubs[0].cancelAtPeriodEnd).toBe(true);
    });
  });

  describe('changePlan — packs are not changeable', () => {
    function activeSubOn(plan: any) {
      return {
        id: 'sub-1',
        user,
        company: 'comp-1',
        plan,
        status: SubscriptionStatus.ACTIVE,
        isActive: true,
        currentPeriodStart: moment().subtract(3, 'days').toDate(),
        currentPeriodEnd: moment().add(27, 'days').toDate(),
        metadata: { history: [] },
      };
    }

    it('rejects changing FROM a pack to a time-based plan', async () => {
      existingSubs = [activeSubOn(PACK_PLAN)];

      await expect(
        service.changePlan({ subscriptionId: 'sub-1', newPlanId: 'plan-time' })
      ).rejects.toThrow(
        BAD_REQUEST_ERRORS.CANNOT_CHANGE_PLAN_WITH_SESSION_PACK
      );
      expect(existingSubs[0].plan).toBe(PACK_PLAN);
    });

    it('rejects changing TO a pack from a time-based plan', async () => {
      existingSubs = [activeSubOn(TIME_PLAN)];

      await expect(
        service.changePlan({ subscriptionId: 'sub-1', newPlanId: 'plan-pack' })
      ).rejects.toThrow(
        BAD_REQUEST_ERRORS.CANNOT_CHANGE_PLAN_WITH_SESSION_PACK
      );
      expect(existingSubs[0].plan).toBe(TIME_PLAN);
    });

    it('rejects the implicit plan change via createSubscription (active time plan → pack today)', async () => {
      currentPlan = PACK_PLAN;
      existingSubs = [activeSubOn(TIME_PLAN)];

      await expect(service.createSubscription(buildInput())).rejects.toThrow(
        BAD_REQUEST_ERRORS.CANNOT_CHANGE_PLAN_WITH_SESSION_PACK
      );
    });
  });
});
