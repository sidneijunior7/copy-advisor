"""Educational area: a manager's modules, lessons and FAQ, who sees them, and the lessons a client finished (education.py)."""
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import education  # noqa: E402
import server  # noqa: E402
from test_clients import claimed_license, client_headers, fresh_limits  # noqa: E402,F401
from test_management import make_manager  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
PANDA = "https://player-vz-7b6cf9e4-8bf.tv.pandavideo.com.br/embed/?v=0d1c1a2b-1111-2222-3333-444455556666"


def test_video_links_become_only_known_players():
    yt = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0"
    for url in (VIDEO, "https://youtu.be/dQw4w9WgXcQ?t=10", "https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
                "https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"):
        assert education.video(url) == {"provider": "youtube", "embed_url": yt}, url
    assert education.video("https://vimeo.com/123456/abcdef1234")["embed_url"] == "https://player.vimeo.com/video/123456?h=abcdef1234"
    assert education.video("https://player.vimeo.com/video/123456")["embed_url"] == "https://player.vimeo.com/video/123456"
    panda = "https://player-vz-7b6cf9e4-8bf.tv.pandavideo.com.br/embed/?v=0d1c1a2b-1111-2222-3333-444455556666"
    assert education.video(panda) == {"provider": "panda", "embed_url": panda}
    for bad in ("http://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ",
                "https://evil.io/?u=https://youtu.be/dQw4w9WgXcQ", "javascript:alert(1)", "https://vimeo.com/abc",
                "https://player-vz-x.tv.pandavideo.com.br.evil.io/embed/?v=0d1c1a2b-1111-2222-3333-444455556666"):
        assert education.video(bad) is None, bad


def test_images_by_link_and_youtube_thumbnails(client):
    _, mgr, _, _, cli, _ = claimed_license(client)
    cover = "https://b-vz-7b6cf9e4-8bf.tv.pandavideo.com.br/0d1c1a2b/cover.jpg"
    module = client.post("/education/modules", headers=mgr, json={"title": "Com capa", "cover_url": f" {cover} ",
                                                                  "published": True}).json()
    assert module["cover_url"] == cover
    for bad in ("http://img.io/a.jpg", "javascript:alert(1)", "https://img/a.jpg"):
        assert client.post("/education/modules", headers=mgr, json={"title": "Ruim", "cover_url": bad}).status_code == 422, bad
    lessons = "/education/modules/{}/lessons".format(module["id"])
    youtube = client.post(lessons, headers=mgr, json={"title": "Do YouTube", "video_url": VIDEO, "published": True}).json()
    assert youtube["thumbnail"] == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" and youtube["thumbnail_url"] is None
    own = client.post(lessons, headers=mgr, json={"title": "Do Panda", "video_url": PANDA, "thumbnail_url": cover,
                                                  "published": True}).json()
    assert own["thumbnail"] == cover == own["thumbnail_url"]
    bare = client.post(lessons, headers=mgr, json={"title": "Só Panda", "video_url": PANDA, "published": True}).json()
    assert bare["thumbnail"] is None  # Panda Video's thumbnail comes only from its API: the page draws a poster
    assert client.post(lessons, headers=mgr, json={"title": "Ruim", "body": "x", "thumbnail_url": "ftp://a.io/x"}).status_code == 422

    [mine] = [m for m in client.get("/me/education", headers=cli).json()["modules"] if m["id"] == module["id"]]
    assert mine["cover"] == cover
    assert [l["thumbnail"] for l in mine["lessons"]] == [youtube["thumbnail"], cover, None]
    assert all("thumbnail_url" not in l for l in mine["lessons"])


def course(client, mgr, audience="clients", published=True):
    r = client.post("/education/modules", headers=mgr, json={"title": "Primeiros passos", "audience": audience,
                                                             "published": published})
    assert r.status_code == 200, r.text
    module = r.json()
    r = client.post(f"/education/modules/{module['id']}/lessons", headers=mgr,
                    json={"title": "Instalar o EA", "video_url": VIDEO, "body": "1. Baixe\n2. Instale", "minutes": 5,
                          "published": True})
    assert r.status_code == 200, r.text
    return module, r.json()


def test_manager_builds_a_course_and_only_its_clients_see_it(client):
    _, mgr, _, _, cli, _ = claimed_license(client)
    module, lesson = course(client, mgr)
    assert lesson["video"]["provider"] == "youtube" and lesson["done_by"] == 0
    draft = client.post(f"/education/modules/{module['id']}/lessons", headers=mgr,
                        json={"title": "Rascunho", "body": "Ainda não"}).json()
    assert client.post(f"/education/modules/{module['id']}/lessons", headers=mgr, json={"title": "Vazia"}).status_code == 422
    assert client.post(f"/education/modules/{module['id']}/lessons", headers=mgr,
                       json={"title": "Fora", "video_url": "https://evil.io/v.mp4"}).status_code == 422
    faq = client.post("/education/faqs", headers=mgr, json={"question": "Preciso deixar o PC ligado?",
                                                             "answer": "Sim, ou use a hospedagem.", "published": True}).json()

    view = client.get("/me/education", headers=cli).json()
    [mine] = [m for m in view["modules"] if m["id"] == module["id"]]
    assert [l["id"] for l in mine["lessons"]] == [lesson["id"]]  # The draft lesson stays out
    assert mine["lessons"][0]["completed"] is False and "video_url" not in mine["lessons"][0]
    assert faq["id"] in [f["id"] for f in view["faqs"]]

    stranger, _ = client_headers(client)
    view = client.get("/me/education", headers=stranger).json()
    assert module["id"] not in [m["id"] for m in view["modules"]] and faq["id"] not in [f["id"] for f in view["faqs"]]
    assert client.put(f"/me/education/lessons/{lesson['id']}/progress", headers=stranger, json={"completed": True}).status_code == 404
    assert client.put(f"/me/education/lessons/{draft['id']}/progress", headers=cli, json={"completed": True}).status_code == 404

    _, intruder = make_manager()
    assert client.put(f"/education/lessons/{lesson['id']}", headers=intruder, json={"title": "Invasão", "body": "Y"}).status_code == 404
    assert client.delete(f"/education/modules/{module['id']}", headers=intruder).status_code == 404
    assert client.get("/education/manage", headers=cli).status_code == 403
    assert client.get("/me/education", headers=mgr).status_code == 403


def test_everyone_audience_reaches_users_without_a_license(client):
    _, mgr = make_manager()
    module, lesson = course(client, mgr, audience="everyone")
    hidden, _ = course(client, mgr, audience="everyone", published=False)
    stranger, _ = client_headers(client)
    ids = [m["id"] for m in client.get("/me/education", headers=stranger).json()["modules"]]
    assert module["id"] in ids and hidden["id"] not in ids


def test_progress_is_counted_for_the_manager_and_goes_with_the_lesson(client):
    _, mgr, _, _, cli, _ = claimed_license(client)
    module, lesson = course(client, mgr)
    for _ in range(2):  # Twice is still once
        assert client.put(f"/me/education/lessons/{lesson['id']}/progress", headers=cli, json={"completed": True}).status_code == 200
    [m] = [m for m in client.get("/education/manage", headers=mgr).json()["modules"] if m["id"] == module["id"]]
    assert m["lessons"][0]["done_by"] == 1
    [m] = [m for m in client.get("/me/education", headers=cli).json()["modules"] if m["id"] == module["id"]]
    assert m["lessons"][0]["completed"] is True
    client.put(f"/me/education/lessons/{lesson['id']}/progress", headers=cli, json={"completed": False})
    [m] = [m for m in client.get("/education/manage", headers=mgr).json()["modules"] if m["id"] == module["id"]]
    assert m["lessons"][0]["done_by"] == 0

    client.put(f"/me/education/lessons/{lesson['id']}/progress", headers=cli, json={"completed": True})
    assert client.delete(f"/education/modules/{module['id']}", headers=mgr).status_code == 200  # Lessons and progress go too
    assert module["id"] not in [m["id"] for m in client.get("/education/manage", headers=mgr).json()["modules"]]


def test_order_names_each_item_once(client):
    _, mgr = make_manager()
    first, _ = course(client, mgr)
    second, _ = course(client, mgr)
    assert client.put("/education/modules/order", headers=mgr, json={"ids": [first["id"]]}).status_code == 422
    assert client.put("/education/modules/order", headers=mgr, json={"ids": [second["id"], first["id"]]}).status_code == 200
    assert [m["id"] for m in client.get("/education/manage", headers=mgr).json()["modules"]] == [second["id"], first["id"]]
    a = client.post("/education/faqs", headers=mgr, json={"question": "Primeira?", "answer": "A"}).json()
    b = client.post("/education/faqs", headers=mgr, json={"question": "Segunda?", "answer": "B"}).json()
    assert client.put("/education/faqs/order", headers=mgr, json={"ids": [b["id"], a["id"], a["id"]]}).status_code == 422
    client.put("/education/faqs/order", headers=mgr, json={"ids": [b["id"], a["id"]]})
    assert [f["id"] for f in client.get("/education/manage", headers=mgr).json()["faqs"]] == [b["id"], a["id"]]


def test_trademetric_content_reaches_every_client_first_and_only_admins_edit_it(client):
    _, admin = make_manager(role="TDM_DEV")
    r = client.post("/education/modules", headers=admin, json={"title": "Como usar o Mirror", "audience": "clients", "published": True})
    assert r.status_code == 200 and r.json()["audience"] == "everyone"  # Trademetric's is always for every client
    official = r.json()
    lesson = client.post(f"/education/modules/{official['id']}/lessons", headers=admin,
                         json={"title": "Instalar o EA", "video_url": PANDA, "published": True}).json()
    assert lesson["video"]["provider"] == "panda"
    faq = client.post("/education/faqs", headers=admin, json={"question": "O que é o Mirror?", "answer": "A cópia.", "published": True}).json()

    _, other_admin = make_manager(role="TDM_DEV")  # Shared by every admin
    assert official["id"] in [m["id"] for m in client.get("/education/manage", headers=other_admin).json()["modules"]]
    _, mgr, _, _, cli, _ = claimed_license(client)
    own, _ = course(client, mgr)
    assert client.put(f"/education/lessons/{lesson['id']}", headers=mgr, json={"title": "Minha", "body": "x"}).status_code == 404
    assert official["id"] not in [m["id"] for m in client.get("/education/manage", headers=mgr).json()["modules"]]
    assert "Como usar o Mirror" in [m["title"] for m in client.get("/education/manage", headers=mgr).json()["official"]]

    for headers in (cli, client_headers(client)[0]):  # A client with a license, and one without
        view = client.get("/me/education", headers=headers).json()
        first = view["modules"][0]
        assert first["id"] == official["id"] and first["official"] and first["manager"] == "Trademetric"
        assert any(f["id"] == faq["id"] and f["official"] for f in view["faqs"])
    assert [m["id"] for m in client.get("/me/education", headers=cli).json()["modules"]].index(own["id"]) > 0
    assert client.put(f"/me/education/lessons/{lesson['id']}/progress", headers=cli, json={"completed": True}).status_code == 200
    [m] = [m for m in client.get("/education/manage", headers=admin).json()["modules"] if m["id"] == official["id"]]
    assert m["lessons"][0]["done_by"] == 1
