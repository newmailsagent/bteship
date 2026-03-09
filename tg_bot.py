#!/usr/bin/env python3
"""
Телеграм-бот для Морского боя.
Токен и URL читаются из переменных окружения — не хранятся в коде.

Переменные окружения:
  BOT_TOKEN        — токен бота от @BotFather
  WEBAPP_URL       — URL фронтенда (https://morskoy-boy.ru)
  GAME_SERVER_URL  — URL Node.js сервера (https://morskoy-boy.ru или http://localhost:3000)
  SHOP_SECRET      — секрет для защищённого эндпоинта /api/reward (совпадает с server.js)
  WEBHOOK_URL      — публичный URL куда TG будет слать апдейты (https://morskoy-boy.ru/bot/webhook)
  WEBHOOK_PATH     — путь вебхука (по умолчанию /bot/webhook)
  WEBHOOK_PORT     — порт на котором слушает бот (по умолчанию 8443)
  WEBHOOK_SECRET   — секрет для проверки запросов от TG (любая случайная строка)
"""

import os
import logging
import asyncio
import aiohttp

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    WebAppInfo,
    LabeledPrice,
)
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    PreCheckoutQueryHandler,
    filters,
    ContextTypes,
)

# ── КОНФИГ ─────────────────────────────────────────────────────────────────────

BOT_TOKEN        = os.environ.get("BOT_TOKEN")
WEBAPP_URL       = os.environ.get("WEBAPP_URL",      "https://morskoy-boy.ru")
GAME_SERVER_URL  = os.environ.get("GAME_SERVER_URL", "http://localhost:3000")
SHOP_SECRET      = os.environ.get("SHOP_SECRET",     "shop_secret_change_me")
WEBHOOK_URL      = os.environ.get("WEBHOOK_URL")      # напр. https://morskoy-boy.ru/bot/webhook
WEBHOOK_PATH     = os.environ.get("WEBHOOK_PATH",    "/bot/webhook")
WEBHOOK_PORT     = int(os.environ.get("WEBHOOK_PORT", 8443))
WEBHOOK_SECRET   = os.environ.get("WEBHOOK_SECRET",  "")  # секрет для X-Telegram-Bot-Api-Secret-Token

GAME_SHARE_TEXT = "Приглашаю тебя поиграть в Морской бой прямо в Telegram:"
GAME_SHARE_URL  = "https://t.me/bteship_bot/bteship"

if not BOT_TOKEN:
    raise RuntimeError("Не задана переменная окружения BOT_TOKEN")

# ── ЛОГИРОВАНИЕ ────────────────────────────────────────────────────────────────

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


# ── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ────────────────────────────────────────────────────

def play_markup():
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("⚓ Играть", web_app=WebAppInfo(url=WEBAPP_URL))
    ]])

def share_and_play_markup():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("⚓ Играть", web_app=WebAppInfo(url=WEBAPP_URL))],
        [InlineKeyboardButton(
            "📤 Поделиться игрой",
            url=f"https://t.me/share/url?text={GAME_SHARE_TEXT}+{GAME_SHARE_URL}"
        )],
    ])

def normalize_user_id(user_id) -> str:
    """Нормализует user_id — убирает .0 если пришло как float."""
    return str(int(float(str(user_id))))

async def call_server(method: str, path: str, **kwargs) -> dict:
    """Вызов внутреннего API Node.js сервера."""
    url = f"{GAME_SERVER_URL}{path}"
    try:
        async with aiohttp.ClientSession() as session:
            async with getattr(session, method)(url, **kwargs) as resp:
                return await resp.json()
    except Exception as e:
        logger.error(f"[API] {method.upper()} {path} failed: {e}")
        return {"ok": False, "error": str(e)}


# ── КОМАНДЫ ────────────────────────────────────────────────────────────────────

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    name = update.effective_user.first_name or "Игрок"
    await update.message.reply_text(
        f"Привет, {name}!\n\n"
        f"<b>Морской бой</b> — классическая игра прямо в Telegram.\n\n"
        f"🔹 Играй против бота или с друзьями онлайн\n"
        f"🔹 Отслеживай свою статистику\n"
        f"🔹 Соревнуйся в общем рейтинге\n"
        f"🔹 Открывай уникальные предметы в магазине\n\n"
        f"Нажми кнопку ниже чтобы начать:",
        parse_mode="HTML",
        reply_markup=share_and_play_markup(),
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "<b>Команды бота:</b>\n\n"
        "/start — приветствие\n"
        "/play  — открыть игру\n"
        "/help  — эта справка",
        parse_mode="HTML",
        reply_markup=play_markup(),
    )

async def play(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Открываю игру:", reply_markup=play_markup())

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Выбери действие 👇",
        reply_markup=share_and_play_markup(),
    )


# ── ПЛАТЕЖИ (TELEGRAM STARS) ───────────────────────────────────────────────────

async def pre_checkout(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    TG присылает pre_checkout_query перед списанием звёзд.
    Нужно ответить в течение 10 секунд — иначе платёж отменится.
    Мы всегда отвечаем OK (нет стока, товары цифровые).
    """
    query = update.pre_checkout_query
    payload = query.invoice_payload  # формат: "userId:itemId:timestamp"

    logger.info(f"[Payment] pre_checkout: payload={payload} user={query.from_user.id}")

    try:
        # Базовая валидация payload
        parts = payload.split(":")
        if len(parts) != 3:
            await query.answer(ok=False, error_message="Неверный формат заказа")
            return

        user_id_in_payload = normalize_user_id(parts[0])
        user_id_actual      = normalize_user_id(query.from_user.id)

        # Проверяем что платит тот же пользователь
        if user_id_in_payload != user_id_actual:
            logger.warning(f"[Payment] user mismatch: payload={user_id_in_payload} actual={user_id_actual}")
            await query.answer(ok=False, error_message="Ошибка авторизации")
            return

        await query.answer(ok=True)

    except Exception as e:
        logger.error(f"[Payment] pre_checkout error: {e}")
        # Даже при ошибке отвечаем OK — лучше не блокировать платёж
        await query.answer(ok=True)


async def successful_payment(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Пользователь успешно оплатил. Записываем покупку через Node.js API.
    """
    sp       = update.message.successful_payment
    payload  = sp.invoice_payload
    charge_id = sp.telegram_payment_charge_id
    user_id  = normalize_user_id(update.effective_user.id)

    logger.info(f"[Payment] successful: user={user_id} payload={payload} charge={charge_id}")

    try:
        parts   = payload.split(":")
        item_id = parts[1] if len(parts) >= 2 else None

        if not item_id:
            logger.error(f"[Payment] bad payload: {payload}")
            return

        # Уведомляем Node.js сервер — записывает в БД и шлёт сокет-событие клиенту
        result = await call_server(
            "post",
            "/api/webhook/telegram",
            json={
                "message": {
                    "successful_payment": {
                        "invoice_payload":                sp.invoice_payload,
                        "telegram_payment_charge_id":     charge_id,
                        "total_amount":                   sp.total_amount,
                        "currency":                       sp.currency,
                    },
                    "_user_id": user_id,  # передаём нормализованный id
                }
            },
            headers={"X-Shop-Secret": SHOP_SECRET},
        )

        if result.get("ok"):
            logger.info(f"[Payment] granted: user={user_id} item={item_id}")
        else:
            logger.error(f"[Payment] server error: {result}")

    except Exception as e:
        logger.error(f"[Payment] successful_payment handler error: {e}")

    # Благодарим пользователя в любом случае
    item_name = parts[1].replace("_", " ").title() if len(parts) >= 2 else "товар"
    await update.message.reply_text(
        f"✅ Оплата прошла успешно!\n\n"
        f"Ваш предмет уже доступен в инвентаре игры.\n"
        f"Откройте игру и перейдите в Профиль → Инвентарь.",
        reply_markup=play_markup(),
    )


async def refunded_payment(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Пользователь получил возврат Stars (через интерфейс Telegram, до 21 дня).
    Блокируем предмет в инвентаре через Node.js API.
    """
    rp        = update.message.refunded_payment
    charge_id = rp.telegram_payment_charge_id
    user_id   = normalize_user_id(update.effective_user.id)

    logger.info(f"[Refund] user={user_id} charge={charge_id}")

    # Уведомляем Node.js — он заблокирует предмет и снимет экипировку
    result = await call_server(
        "post",
        "/api/webhook/telegram",
        json={
            "message": {
                "refunded_payment": {
                    "telegram_payment_charge_id": charge_id,
                },
                "_user_id": user_id,
            }
        },
        headers={"X-Shop-Secret": SHOP_SECRET},
    )

    if result.get("ok"):
        logger.info(f"[Refund] item revoked for user={user_id}")
    else:
        logger.error(f"[Refund] server error: {result}")

    await update.message.reply_text(
        "Возврат звёзд обработан. Предмет был удалён из вашего инвентаря.\n\n"
        "Если у вас есть вопросы — напишите нам.",
    )


# ── НАСТРОЙКА И ЗАПУСК ─────────────────────────────────────────────────────────

def build_app() -> Application:
    app = Application.builder().token(BOT_TOKEN).build()

    # Команды
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("play",  play))
    app.add_handler(CommandHandler("help",  help_command))

    # Платежи — порядок важен: pre_checkout должен быть ДО successful_payment
    app.add_handler(PreCheckoutQueryHandler(pre_checkout))

    # successful_payment и refunded_payment приходят как обычные Message
    app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, successful_payment))
    app.add_handler(MessageHandler(filters.StatusUpdate.ALL, refunded_payment_filter))

    # Обычные сообщения — в самом конце
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    return app


async def refunded_payment_filter(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Фильтруем refunded_payment из StatusUpdate."""
    if update.message and update.message.refunded_payment:
        await refunded_payment(update, context)


def main() -> None:
    app = build_app()

    if WEBHOOK_URL:
        # ── WEBHOOK режим (продакшн) ──────────────────────────────────────────
        logger.info(f"[Bot] Запуск в режиме webhook: {WEBHOOK_URL}")
        logger.info(f"[Bot] Слушаем на порту {WEBHOOK_PORT}, путь {WEBHOOK_PATH}")

        app.run_webhook(
            listen="0.0.0.0",
            port=WEBHOOK_PORT,
            url_path=WEBHOOK_PATH,
            webhook_url=WEBHOOK_URL,
            # Секрет для проверки что запрос действительно от TG
            secret_token=WEBHOOK_SECRET if WEBHOOK_SECRET else None,
            # Даём TG знать что принимаем все типы апдейтов включая платежи
            allowed_updates=[
                "message",
                "pre_checkout_query",
            ],
        )
    else:
        # ── POLLING режим (локальная разработка) ─────────────────────────────
        logger.info(f"[Bot] Запуск в режиме polling (WEBHOOK_URL не задан)")
        app.run_polling(
            allowed_updates=[
                "message",
                "pre_checkout_query",
            ]
        )


if __name__ == "__main__":
    main()
