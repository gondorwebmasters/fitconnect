import { Migration } from '@mikro-orm/migrations';

/**
 * Añade a la reserva (`user_schedules`) **qué suscripción la pagó** — #21,
 * ADR 0006 decisión 6.
 *
 * Hasta ahora el reembolso re-derivaba la suscripción del miembro al
 * desapuntarse. Con una sola vigente acierta siempre; con dos devuelve el
 * crédito a la equivocada, y un crédito que aparece donde no debe solo se nota
 * cuando las cuentas ya no cuadran.
 *
 * Las reservas existentes se quedan a `null`, y no hay nada que rellenar: para
 * que una reserva vieja hubiera pagado un crédito tendría que existir algún
 * **Session Pack**, y en producción no hay ninguno. La migración **lo
 * comprueba** en vez de suponerlo: si aparece una suscripción con créditos,
 * aborta antes de tocar nada y el backfill se diseña con los datos delante.
 */
export class Migration20260928120000 extends Migration {
  override async up(): Promise<void> {
    await this.assertNoSessionPacksExist();

    this.addSql(
      `alter table "user_schedules" add column "paid_by_subscription_id" uuid null;`
    );
    this.addSql(
      `alter table "user_schedules" add constraint "user_schedules_paid_by_subscription_id_foreign" foreign key ("paid_by_subscription_id") references "subscription" ("id") on update cascade on delete set null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "user_schedules" drop constraint "user_schedules_paid_by_subscription_id_foreign";`
    );
    this.addSql(
      `alter table "user_schedules" drop column "paid_by_subscription_id";`
    );
  }

  /**
   * Ninguna suscripción lleva créditos ⇒ ninguna reserva pudo gastar uno ⇒ no
   * hay nada que reconstruir. Se ejecuta de inmediato (no `addSql`) para poder
   * abortar antes de emitir el `alter table`.
   */
  private async assertNoSessionPacksExist(): Promise<void> {
    const rows = await this.execute(
      `select count(*)::int as total from "subscription" where "credits_total" is not null`
    );
    const total = Number(rows[0]?.total);

    // Un recuento que no llega, o que no es un número, no es un "cero": es una
    // comprobación que no se ha hecho. Abortar también entonces, porque el
    // punto de la asunción es no migrar a ciegas.
    if (!Number.isFinite(total)) {
      throw new Error(
        `Migration20260928120000 aborted: could not count subscriptions carrying a credits_total ` +
          `(unexpected result shape: ${JSON.stringify(rows)}). The migration refuses to assume zero.`
      );
    }

    if (total > 0) {
      throw new Error(
        `Migration20260928120000 aborted: ${total} subscription(s) already carry a credits_total. ` +
          `This migration assumes no Session Pack exists yet, so existing registrations need no backfill ` +
          `of paid_by_subscription_id. Design the backfill before migrating.`
      );
    }
  }
}
