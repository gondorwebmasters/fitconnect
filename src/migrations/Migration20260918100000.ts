import { Migration } from '@mikro-orm/migrations';

/**
 * Session Pack (Bono) — migración aditiva.
 * - plan.session_count: nº de Session Credits del plan (null = ilimitado).
 * - subscription.credits_total: snapshot del plan al crear (null = ilimitado).
 * - subscription.credits_used: créditos consumidos (default 0).
 */
export class Migration20260918100000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "plan" add column "session_count" smallint null;`);
    this.addSql(`alter table "subscription" add column "credits_total" smallint null, add column "credits_used" smallint not null default 0;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "plan" drop column "session_count";`);
    this.addSql(`alter table "subscription" drop column "credits_total", drop column "credits_used";`);
  }

}
