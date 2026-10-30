"""
Educational area: modules of lessons (a video by link and the text under it) and a FAQ, from two kinds of owner:

- Trademetric (manager_id NULL), edited by any TDM_DEV: how to use the Mirror. Every client sees it, first, marked
  official, so a manager does not have to teach the platform.
- A manager: about its own product. A module or a question is for the manager's clients (anyone with a license of one
  of its portfolios or strategies, expired ones included) or for every user of the Mirror.

A client marks the lessons it finished, and the owner sees how many did each one.

The video is never uploaded here: the owner pastes the link of a YouTube, Vimeo or Panda Video video (unlisted
works), and the player's address is worked out from it, so the page only ever frames those three players.
"""
import datetime
import re
from typing import Dict, Iterable, List, Literal, Optional, Set

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

import hosting
import models

PLATFORM = "Trademetric"  # The owner's name on the platform's own content
MAX_MODULES = 50
MAX_LESSONS_PER_MODULE = 100
MAX_FAQS = 200

_YOUTUBE_ID = r"([A-Za-z0-9_-]{11})"
_YOUTUBE = [
    re.compile(r"^https://(?:www\.|m\.)?youtube\.com/watch\?(?:[^#\s]*&)?v=" + _YOUTUBE_ID + r"(?:[&#][^\s]*)?$"),
    re.compile(r"^https://youtu\.be/" + _YOUTUBE_ID + r"(?:[?#][^\s]*)?$"),
    re.compile(r"^https://(?:www\.)?youtube(?:-nocookie)?\.com/(?:embed|shorts|live)/" + _YOUTUBE_ID + r"(?:[?#][^\s]*)?$"),
]
_VIMEO = [
    re.compile(r"^https://(?:www\.)?vimeo\.com/(\d{1,12})(?:/([0-9a-f]{6,20}))?/?(?:[?#][^\s]*)?$"),
    re.compile(r"^https://player\.vimeo\.com/video/(\d{1,12})(?:\?(?:[^#\s]*&)?h=([0-9a-f]{6,20}))?(?:[&#][^\s]*)?$"),
]
_PANDA = re.compile(r"^https://(player-vz-[a-z0-9-]{1,40}\.tv\.pandavideo\.com(?:\.br)?)/embed/\?v=([0-9a-f-]{36})(?:&[^\s]*)?$")


def video(url: Optional[str]) -> Optional[dict]:
    """The player of a video link, or None when the link is not of a video we frame."""
    if not url:
        return None
    url = url.strip()
    for pattern in _YOUTUBE:
        m = pattern.match(url)
        if m:
            return {"provider": "youtube", "embed_url": f"https://www.youtube-nocookie.com/embed/{m.group(1)}?rel=0"}
    for pattern in _VIMEO:
        m = pattern.match(url)
        if m:
            hash_ = f"?h={m.group(2)}" if m.group(2) else ""
            return {"provider": "vimeo", "embed_url": f"https://player.vimeo.com/video/{m.group(1)}{hash_}"}
    m = _PANDA.match(url)
    if m:
        return {"provider": "panda", "embed_url": f"https://{m.group(1)}/embed/?v={m.group(2)}"}
    return None


Audience = Literal["clients", "everyone"]


class ModuleIn(BaseModel):
    title: str = Field(min_length=2, max_length=120, pattern=hosting.ONE_LINE)
    description: Optional[str] = Field(default=None, max_length=500)
    audience: Audience = "clients"
    published: bool = False


class LessonIn(BaseModel):
    title: str = Field(min_length=2, max_length=120, pattern=hosting.ONE_LINE)
    summary: Optional[str] = Field(default=None, max_length=300, pattern=hosting.ONE_LINE)
    video_url: Optional[str] = Field(default=None, max_length=500)
    body: Optional[str] = Field(default=None, max_length=20000)
    minutes: Optional[int] = Field(default=None, ge=1, le=600)
    published: bool = False

    @field_validator("video_url")
    @classmethod
    def known_player(cls, v: Optional[str]) -> Optional[str]:
        v = (v or "").strip() or None
        if v is not None and video(v) is None:
            raise ValueError("Use o link de um vídeo do YouTube, do Vimeo ou do Panda Video")
        return v


class FaqIn(BaseModel):
    question: str = Field(min_length=3, max_length=300, pattern=hosting.ONE_LINE)
    answer: str = Field(min_length=1, max_length=10000)
    audience: Audience = "clients"
    published: bool = False


class Order(BaseModel):
    ids: List[int] = Field(max_length=MAX_FAQS)


class ProgressIn(BaseModel):
    completed: bool


def _text(value: Optional[str]) -> Optional[str]:
    return (value or "").replace("\x00", "").strip() or None


def apply_module(module: models.EduModule, data: ModuleIn, now: datetime.datetime):
    module.title = data.title.strip()
    module.description = _text(data.description)
    module.audience = data.audience if module.manager_id is not None else "everyone"  # Trademetric's is for every client
    module.published = data.published
    module.updated_at = now


def apply_lesson(lesson: models.EduLesson, data: LessonIn, now: datetime.datetime):
    lesson.title = data.title.strip()
    lesson.summary = _text(data.summary)
    lesson.video_url = data.video_url
    lesson.body = _text(data.body)
    lesson.minutes = data.minutes
    lesson.published = data.published
    lesson.updated_at = now


def apply_faq(faq: models.EduFaq, data: FaqIn, now: datetime.datetime):
    faq.question = data.question.strip()
    faq.answer = _text(data.answer) or ""
    faq.audience = data.audience if faq.manager_id is not None else "everyone"
    faq.published = data.published
    faq.updated_at = now


def reorder(items: Iterable, ids: List[int]) -> bool:
    """Puts the items in the order of ids, which must name each of them once."""
    by_id = {i.id: i for i in items}
    if sorted(ids) != sorted(by_id):
        return False
    for position, item_id in enumerate(ids):
        by_id[item_id].position = position
    return True


def next_position(db: Session, column, *criteria) -> int:
    return (db.query(func.max(column)).filter(*criteria).scalar() or -1) + 1


# --- The owner's side: a manager's own content, or Trademetric's (owner None) ---

def owner_name(manager: Optional[models.User]) -> str:
    return PLATFORM if manager is None else (manager.name or "Gestor")


def lesson_out(lesson: models.EduLesson, completed: Optional[bool] = None, done_by: Optional[int] = None) -> dict:
    out = {"id": lesson.id, "module_id": lesson.module_id, "title": lesson.title, "summary": lesson.summary,
           "video": video(lesson.video_url), "body": lesson.body, "minutes": lesson.minutes}
    if completed is not None:
        out["completed"] = completed
    if done_by is not None:  # The owner's view
        out |= {"video_url": lesson.video_url, "published": bool(lesson.published), "done_by": done_by,
                "updated_at": lesson.updated_at}
    return out


def module_out(module: models.EduModule, done: Dict[int, int]) -> dict:
    return {"id": module.id, "title": module.title, "description": module.description, "audience": module.audience,
            "published": bool(module.published), "updated_at": module.updated_at,
            "lessons": [lesson_out(l, done_by=done.get(l.id, 0)) for l in module.lessons]}


def faq_out(faq: models.EduFaq, manage: bool = False) -> dict:
    out = {"id": faq.id, "question": faq.question, "answer": faq.answer}
    if manage:
        out |= {"audience": faq.audience, "published": bool(faq.published), "updated_at": faq.updated_at}
    else:
        out |= {"manager": owner_name(faq.manager), "official": faq.manager_id is None}
    return out


def done_by(db: Session, lesson_ids: List[int]) -> Dict[int, int]:
    """How many users finished each lesson."""
    if not lesson_ids:
        return {}
    return dict(db.query(models.EduProgress.lesson_id, func.count(models.EduProgress.id))
                .filter(models.EduProgress.lesson_id.in_(lesson_ids))
                .group_by(models.EduProgress.lesson_id).all())


def platform_outline(db: Session) -> List[dict]:
    """What Trademetric already teaches every client, so a manager does not record it again."""
    modules = (db.query(models.EduModule)
               .filter(models.EduModule.manager_id.is_(None), models.EduModule.published.is_(True))
               .order_by(models.EduModule.position, models.EduModule.id).all())
    return [{"title": m.title, "lessons": [l.title for l in m.lessons if l.published]} for m in modules
            if any(l.published for l in m.lessons)]


def manage_view(db: Session, owner: Optional[int]) -> dict:
    modules = (db.query(models.EduModule).filter(models.EduModule.manager_id == owner)
               .order_by(models.EduModule.position, models.EduModule.id).all())
    done = done_by(db, [l.id for m in modules for l in m.lessons])
    faqs = (db.query(models.EduFaq).filter(models.EduFaq.manager_id == owner)
            .order_by(models.EduFaq.position, models.EduFaq.id).all())
    out = {"modules": [module_out(m, done) for m in modules], "faqs": [faq_out(f, manage=True) for f in faqs],
           "platform": owner is None}
    if owner is None:
        out["clients"] = db.query(models.User).filter(models.User.role == "CLIENT", models.User.status == "active").count()
    else:
        out["clients"] = len(client_ids(db, owner))
        out["official"] = platform_outline(db)
    return out


def client_ids(db: Session, manager_id: int) -> Set[int]:
    """The client accounts with a license of the manager, expired or revoked ones included."""
    rows = (db.query(models.License.client_user_id)
            .outerjoin(models.Portfolio, models.License.portfolio_id == models.Portfolio.id)
            .outerjoin(models.Strategy, models.License.strategy_id == models.Strategy.id)
            .filter(models.License.client_user_id.isnot(None),
                    or_(models.Portfolio.user_id == manager_id, models.Strategy.user_id == manager_id))
            .distinct().all())
    return {r[0] for r in rows}


# --- The client's side ---

def manager_ids(db: Session, user: models.User) -> Set[int]:
    """The managers the client has a license of, expired or revoked ones included."""
    portfolio_owners = (db.query(models.Portfolio.user_id).join(models.License, models.License.portfolio_id == models.Portfolio.id)
                        .filter(models.License.client_user_id == user.id).distinct().all())
    strategy_owners = (db.query(models.Strategy.user_id).join(models.License, models.License.strategy_id == models.Strategy.id)
                       .filter(models.License.client_user_id == user.id).distinct().all())
    return {r[0] for r in portfolio_owners + strategy_owners}


def _visible(model, db: Session, managers: Set[int]):
    """Trademetric's, and those of managers still active for every user or for their clients."""
    audience = or_(model.audience == "everyone", model.manager_id.in_(managers)) if managers else model.audience == "everyone"
    return or_(model.manager_id.is_(None), and_(model.manager_id.in_(active_managers(db)), audience))


def _rank(managers: Set[int]):
    """Trademetric's first, then the client's own managers', then the others'. Sorted stably: keeps each one's order."""
    return lambda item: (item.manager_id is not None, item.manager_id not in managers)


def active_managers(db: Session) -> Set[int]:
    return {r[0] for r in db.query(models.User.id).filter(models.User.role == "MANAGER", models.User.status == "active")}


def visible_modules(db: Session, user: models.User) -> List[models.EduModule]:
    managers = manager_ids(db, user)
    modules = (db.query(models.EduModule)
               .filter(models.EduModule.published.is_(True), _visible(models.EduModule, db, managers))
               .order_by(models.EduModule.manager_id, models.EduModule.position, models.EduModule.id).all())
    return sorted(modules, key=_rank(managers))


def visible_lesson(db: Session, user: models.User, lesson_id: int) -> Optional[models.EduLesson]:
    lesson = db.get(models.EduLesson, lesson_id)
    if lesson is None or not lesson.published:
        return None
    return lesson if any(m.id == lesson.module_id for m in visible_modules(db, user)) else None


def client_view(db: Session, user: models.User) -> dict:
    modules = visible_modules(db, user)
    done = {r[0] for r in db.query(models.EduProgress.lesson_id).filter(models.EduProgress.user_id == user.id)}
    out_modules = []
    for m in modules:
        lessons = [lesson_out(l, completed=l.id in done) for l in m.lessons if l.published]
        if lessons:
            out_modules.append({"id": m.id, "title": m.title, "description": m.description, "manager": owner_name(m.manager),
                                "official": m.manager_id is None, "lessons": lessons})
    managers = manager_ids(db, user)
    faqs = (db.query(models.EduFaq)
            .filter(models.EduFaq.published.is_(True), _visible(models.EduFaq, db, managers))
            .order_by(models.EduFaq.manager_id, models.EduFaq.position, models.EduFaq.id).all())
    faqs.sort(key=_rank(managers))
    return {"modules": out_modules, "faqs": [faq_out(f) for f in faqs]}


def set_progress(db: Session, user: models.User, lesson: models.EduLesson, completed: bool, now: datetime.datetime):
    row = (db.query(models.EduProgress)
           .filter(models.EduProgress.user_id == user.id, models.EduProgress.lesson_id == lesson.id).first())
    if completed and row is None:
        db.add(models.EduProgress(user_id=user.id, lesson_id=lesson.id, completed_at=now))
    elif not completed and row is not None:
        db.delete(row)
