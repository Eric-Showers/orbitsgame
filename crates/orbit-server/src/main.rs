//! Orbit game server. For now: a health check and a websocket that streams
//! the smoke-test simulation, proving the shared sim runs natively.

use std::time::Duration;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use orbit_sim::World;

const TICK: Duration = Duration::from_millis(50);

fn app() -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(stream_sim)
}

async fn stream_sim(mut socket: WebSocket) {
    let mut world = World::new(1.0);
    world.add_circular_orbit(1.0);
    let mut interval = tokio::time::interval(TICK);
    loop {
        interval.tick().await;
        world.step(TICK.as_secs_f64());
        let Ok(json) = serde_json::to_string(&world) else {
            break;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            break;
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let addr = std::env::var("ORBIT_SERVER_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind server address");
    tracing::info!("orbit-server listening on http://{addr}");
    axum::serve(listener, app()).await.expect("server error");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_returns_ok() {
        let res = app()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"ok");
    }
}
