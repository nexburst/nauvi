//! `nauvi://` links to one object (#299). The format and its checks are in
//! the core (`nauvi::links`), shared with the CLI's `nauvi link` (#548);
//! where an opened link goes is `route`.
//!
//! A link only ever navigates: `route` opens the object's detail panel in a
//! window on that context, if the context is one of the user's.

mod route;

pub(crate) use nauvi::links::{is_link, parse, ObjectLink};
#[cfg(target_os = "macos")]
pub(crate) use route::opened;
pub(crate) use route::{
    check, deliver_quiet, open_from_args, open_launch_link, take, LinkPending, LinkRequest,
};
