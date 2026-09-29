import moment from 'moment';

import { Plan, PlanInterval } from '../../entities/Plan';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import {
  BadRequestError,
  ConflictError,
  BAD_REQUEST_ERRORS,
  CONFLICT_ERRORS,
} from '../../utils/errors.util';
import { SubscriptionService } from '../subscription.service';

/**
 * Tests del seam SubscriptionService.createSubscription para las
 * Suscripciones Retroactivas (backdated free/cash subscriptions) — issue #2.
 *
 * Sigue el prior art de schedule.service.test.ts: EntityManager + procesador
 * de pago mockeados, y las aserciones son sobre la ServiceResponse devuelta y
 * el estado de la entidad creada, nunca sobre qué rama interna se eligió.
 */
describe('SubscriptionService.createSubscription — backdated free subscriptions', () => {
  let service: SubscriptionService;
  let mockEm: any;
  let user: User;
  let existingSubs: any[];
  let currentPlan: any;

  /**
   * Evalúa el where de un findOne(Subscription) contra existingSubs aplicando
   * los mismos predicados que la query real (plan, status $in, y la
   * intersección de intervalos currentPeriodStart <= newEnd &&
   * currentPeriodEnd >= newStart). Así los tests ejercitan de verdad la
   * exclusión de CANCELED, el alcance **por plan** y el cálculo de
   * solapamiento, en lugar de devolver un stub fijo.
   */
  function matchSubscription(where: any): any {
    return (
      existingSubs.find(s => {
        if (where.company && s.company !== where.company) return false;
        if (where.plan && s.plan?.id !== where.plan.id) return false;
        if (where.status?.$in && !where.status.$in.includes(s.status)) {
          return false;
        }
        if (
          where.currentPeriodStart?.$lte !== undefined &&
          !(s.currentPeriodStart <= where.currentPeriodStart.$lte)
        ) {
          return false;
        }
        if (
          where.currentPeriodEnd?.$gte !== undefined &&
          !(s.currentPeriodEnd >= where.currentPeriodEnd.$gte)
        ) {
          return false;
        }
        return true;
      }) ?? null
    );
  }

  const FREE_PLAN: any = {
    id: 'plan-free',
    amount: 0,
    interval: PlanInterval.MONTH,
    intervalCount: 1,
    currency: 'eur',
    name: 'Cash membership',
    trialPeriodDays: 0,
    isActive: true,
    company: { id: 'comp-1' },
  };

  const PAID_PLAN: any = {
    id: 'plan-paid',
    amount: 5000,
    interval: PlanInterval.MONTH,
    intervalCount: 1,
    currency: 'eur',
    name: 'Premium',
    trialPeriodDays: 0,
    isActive: true,
    company: { id: 'comp-1' },
  };

  function buildInput(overrides: Record<string, any> = {}) {
    return {
      userId: 'user-1',
      planId: 'plan-free',
      companyId: 'comp-1',
      ...overrides,
    };
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    existingSubs = [];

    mockEm = {
      findOne: jest.fn((entity: any, where: any) => {
        if (entity === User) return user;
        if (entity === Plan) return currentPlan;
        if (entity === Subscription) return matchSubscription(where);
        return null;
      }),
      find: jest.fn(async () => []),
      create: jest.fn((_entity: any, data: any) => ({ ...data })),
      persist: jest.fn(),
      flush: jest.fn(async () => {}),
      refresh: jest.fn(async () => {}),
    };

    // El plan que devuelve getActivePlanOrFail se ajusta por test.
    currentPlan = FREE_PLAN;

    service = new SubscriptionService(mockEm as any, {} as any);
    // getOrCreateCustomer solo necesita devolver algo con forma de Customer.
    (service as any).customerService.getOrCreateCustomer = jest
      .fn()
      .mockResolvedValue({ id: 'cust-1' });
  });

  describe('happy path', () => {
    it('creates an ACTIVE subscription with backdated dates and does not gift the elapsed days', async () => {
      currentPlan = FREE_PLAN;
      const backdated = moment().subtract(10, 'days').startOf('day');

      const response = await service.createSubscription(
        buildInput({ startDate: backdated.toDate() })
      );

      expect(response.code).toBe(201);
      expect(response.success).toBe(true);

      const sub = (response as any).subscription;
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);

      // currentPeriodStart es la fecha retroactiva, no hoy.
      expect(moment(sub.currentPeriodStart).isSame(backdated, 'day')).toBe(
        true
      );

      // El período termina antes que si hubiese empezado hoy (días no regalados)
      // y sigue siendo estrictamente posterior a hoy.
      expect(moment(sub.currentPeriodEnd).isAfter(moment(), 'day')).toBe(true);
      expect(
        moment(sub.currentPeriodEnd).isBefore(moment().add(1, 'month'), 'day')
      ).toBe(true);

      // nextBillingDate coincide con el fin de período.
      expect(sub.nextBillingDate).toEqual(sub.currentPeriodEnd);
    });

    it('records a backdated-cash history entry', async () => {
      currentPlan = FREE_PLAN;
      const backdated = moment().subtract(5, 'days').startOf('day');

      const response = await service.createSubscription(
        buildInput({ startDate: backdated.toDate() })
      );

      const sub = (response as any).subscription;
      expect(sub.metadata.backdated).toBe(true);
      const history = sub.metadata.history as any[];
      expect(history.some(h => h.event === 'backdated_cash')).toBe(true);
    });

    it('allows backdating over a CANCELED subscription whose dates DO overlap', async () => {
      currentPlan = FREE_PLAN;
      const backdated = moment().subtract(7, 'days').startOf('day');
      // Una CANCELED cuyo período se solapa con el nuevo span: debe ser
      // ignorada por el filtro de status y NO bloquear.
      existingSubs = [
        {
          id: 'sub-canceled',
          company: 'comp-1',
          plan: FREE_PLAN,
          status: SubscriptionStatus.CANCELED,
          currentPeriodStart: moment().subtract(20, 'days').toDate(),
          currentPeriodEnd: moment().add(10, 'days').toDate(),
        },
      ];

      const response = await service.createSubscription(
        buildInput({ startDate: backdated.toDate() })
      );

      expect(response.code).toBe(201);
      expect((response as any).subscription.status).toBe(
        SubscriptionStatus.ACTIVE
      );
    });

    it('allows backdating when an ACTIVE sub exists but its period does NOT overlap', async () => {
      currentPlan = FREE_PLAN;
      const backdated = moment().subtract(7, 'days').startOf('day');
      // ACTIVE pero su período terminó ANTES del inicio retroactivo → sin
      // solapamiento → permitido. Ejercita la aritmética de intersección.
      existingSubs = [
        {
          id: 'sub-old-active',
          company: 'comp-1',
          plan: FREE_PLAN,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: moment().subtract(60, 'days').toDate(),
          currentPeriodEnd: moment().subtract(30, 'days').toDate(),
        },
      ];

      const response = await service.createSubscription(
        buildInput({ startDate: backdated.toDate() })
      );

      expect(response.code).toBe(201);
    });
  });

  describe('rejections', () => {
    it('rejects a backdate whose whole period has already elapsed', async () => {
      currentPlan = FREE_PLAN;
      const backdated = moment().subtract(40, 'days').startOf('day');

      await expect(
        service.createSubscription(
          buildInput({ startDate: backdated.toDate() })
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.BACKDATED_PERIOD_ALREADY_ELAPSED);
    });

    it.each([
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIALING,
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.PAUSED,
    ])(
      'rejects a backdate overlapping a %s subscription to the same plan',
      async status => {
        currentPlan = FREE_PLAN;
        const backdated = moment().subtract(10, 'days').startOf('day');
        // Período que se solapa con el nuevo span [backdated, +~20d].
        existingSubs = [
          {
            id: 'sub-existing',
            company: 'comp-1',
            plan: FREE_PLAN,
            status,
            currentPeriodStart: moment().subtract(5, 'days').toDate(),
            currentPeriodEnd: moment().add(5, 'days').toDate(),
          },
        ];

        await expect(
          service.createSubscription(
            buildInput({ startDate: backdated.toDate() })
          )
        ).rejects.toThrow(
          CONFLICT_ERRORS.BACKDATED_OVERLAPS_EXISTING_ENTITLEMENT
        );
      }
    );
  });

  describe('paid plans are unaffected', () => {
    it('rejects a paid plan with a past startDate (must start today)', async () => {
      currentPlan = PAID_PLAN;
      const past = moment().subtract(3, 'days').startOf('day');

      await expect(
        service.createSubscription(
          buildInput({ planId: 'plan-paid', startDate: past.toDate() })
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.PAID_PLAN_MUST_START_TODAY);
    });

    it('rejects a paid plan with a future startDate (must start today)', async () => {
      currentPlan = PAID_PLAN;
      const future = moment().add(5, 'days').startOf('day');

      await expect(
        service.createSubscription(
          buildInput({ planId: 'plan-paid', startDate: future.toDate() })
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.PAID_PLAN_MUST_START_TODAY);
    });
  });

  describe('non-backdated free requests keep their existing behavior', () => {
    it('does not take the backdated branch for a free plan starting today', async () => {
      currentPlan = FREE_PLAN;
      (service as any).getDefaultPaymentMethod = jest
        .fn()
        .mockResolvedValue(null);

      const response = await service.createSubscription(
        buildInput({ startDate: moment().startOf('day').toDate() })
      );

      const sub = (response as any).subscription;
      // La rama de backdating marca metadata.backdated; el flujo normal no.
      expect(sub.metadata.backdated).toBeUndefined();
      expect(moment(sub.currentPeriodStart).isSame(moment(), 'day')).toBe(true);
    });

    it('does not take the backdated branch for a free plan starting in the future', async () => {
      currentPlan = FREE_PLAN;
      (service as any).getDefaultPaymentMethod = jest
        .fn()
        .mockResolvedValue(null);
      const future = moment().add(6, 'days').startOf('day');

      const response = await service.createSubscription(
        buildInput({ startDate: future.toDate() })
      );

      const sub = (response as any).subscription;
      expect(sub.metadata.backdated).toBeUndefined();
      // La fecha futura se conserva (no se reescribe a hoy).
      expect(moment(sub.currentPeriodStart).isSame(future, 'day')).toBe(true);
    });
  });

  describe('validation errors surface as typed errors', () => {
    it('throws BadRequestError for a paid-plan future start', async () => {
      currentPlan = PAID_PLAN;
      await expect(
        service.createSubscription(
          buildInput({
            planId: 'plan-paid',
            startDate: moment().add(2, 'days').toDate(),
          })
        )
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it('throws ConflictError on backdate overlap', async () => {
      currentPlan = FREE_PLAN;
      existingSubs = [
        {
          id: 'sub-x',
          company: 'comp-1',
          plan: FREE_PLAN,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: moment().subtract(2, 'days').toDate(),
          currentPeriodEnd: moment().add(10, 'days').toDate(),
        },
      ];
      await expect(
        service.createSubscription(
          buildInput({ startDate: moment().subtract(4, 'days').toDate() })
        )
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  // Guard endurecido del cobro: la rama de plan gratuito de attemptCharge solo
  // debe reescribir las fechas a hoy cuando el período empieza HOY. Un período
  // retroactivo (inicio pasado) que llegue a esta ruta debe conservar sus
  // fechas. Defensivo — la ruta dedicada ni siquiera llama a attemptCharge.
  describe('attemptCharge free-plan date guard', () => {
    it('does not reset a past-start free sub to today', async () => {
      const past = moment().subtract(9, 'days').startOf('day').toDate();
      const originalEnd = moment().add(21, 'days').startOf('day').toDate();
      const sub: any = {
        plan: FREE_PLAN,
        status: SubscriptionStatus.INCOMPLETE,
        currentPeriodStart: past,
        currentPeriodEnd: originalEnd,
        nextBillingDate: originalEnd,
        metadata: {},
      };

      await (service as any).attemptCharge(sub);

      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      // Las fechas retroactivas se conservan, no se aplastan a hoy.
      expect(sub.currentPeriodStart).toBe(past);
      expect(sub.currentPeriodEnd).toBe(originalEnd);
    });

    it('resets a today-start free sub to a fresh period from today', async () => {
      const today = moment().startOf('day');
      const sub: any = {
        plan: FREE_PLAN,
        status: SubscriptionStatus.INCOMPLETE,
        currentPeriodStart: today.toDate(),
        currentPeriodEnd: today.toDate(),
        nextBillingDate: today.toDate(),
        metadata: {},
      };

      await (service as any).attemptCharge(sub);

      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(moment(sub.currentPeriodStart).isSame(today, 'day')).toBe(true);
      // El período se recalcula desde hoy (mes vista para el FREE_PLAN mensual).
      expect(moment(sub.currentPeriodEnd).isAfter(today, 'day')).toBe(true);
    });
  });
});
