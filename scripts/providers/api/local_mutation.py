"""Owner-reported local-source mutation facts attached to failed requests."""
from contextlib import contextmanager


def attempt_metadata(workspace_key, kind, **identity):
    return {"scope": "LOCAL_SOURCE", "state": "NOT_STARTED", "workspaceKey": workspace_key,
            "kind": kind, **identity}


@contextmanager
def local_mutation(workspace_key, kind, **identity):
    attempt = attempt_metadata(workspace_key, kind, **identity)
    try:
        yield attempt
    except (Exception, SystemExit) as error:
        error.mutation = dict(attempt)
        raise


def invocation_attempt(action, arguments):
    """Identify the rejected source invocation before calling its workspace owner."""
    arguments = arguments if isinstance(arguments, dict) else {}
    fields = {"write_document": ("leaseId", "previewId"),
              "apply_source_batch": ("planId", "planHash"),
              "recover_source_batch": ("operationId",)}[action]
    return attempt_metadata(arguments.get("workspaceKey"), "document" if action == "write_document" else "source-batch",
                            **{field: arguments[field] for field in fields if field in arguments})
