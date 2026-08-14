export class AppError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class UnauthorizedError extends AppError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'Authentication required');
  }
}

export class InvalidCredentialsError extends AppError {
  constructor() {
    super(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
}

export class EmailTakenError extends AppError {
  constructor() {
    super(409, 'EMAIL_TAKEN', 'Email already registered');
  }
}

export class InvalidRefreshTokenError extends AppError {
  constructor() {
    super(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid, expired, or revoked');
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, 'FORBIDDEN', message);
  }
}

export class UserNotFoundError extends AppError {
  constructor() {
    super(404, 'USER_NOT_FOUND', 'No registered user with that email');
  }
}

export class MemberNotFoundError extends AppError {
  constructor() {
    super(404, 'MEMBER_NOT_FOUND', 'User is not a member of this organization');
  }
}

export class AlreadyMemberError extends AppError {
  constructor() {
    super(409, 'ALREADY_MEMBER', 'User is already a member of this organization');
  }
}

export class LastAdminError extends AppError {
  constructor() {
    super(409, 'LAST_ADMIN', 'An organization must keep at least one admin');
  }
}

export class ProjectNotFoundError extends AppError {
  constructor() {
    super(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
}

export class TaskNotFoundError extends AppError {
  constructor() {
    super(404, 'TASK_NOT_FOUND', 'Task not found');
  }
}

export class UserNotOrgMemberError extends AppError {
  constructor() {
    super(400, 'USER_NOT_ORG_MEMBER', 'Assignee is not a member of this organization');
  }
}

export class AlreadyAssignedError extends AppError {
  constructor() {
    super(409, 'ALREADY_ASSIGNED', 'User is already assigned to this task');
  }
}

export class AssignmentNotFoundError extends AppError {
  constructor() {
    super(404, 'ASSIGNMENT_NOT_FOUND', 'User is not assigned to this task');
  }
}

export class CommentNotFoundError extends AppError {
  constructor() {
    super(404, 'COMMENT_NOT_FOUND', 'Comment not found');
  }
}

export class JobNotFoundError extends AppError {
  constructor() {
    super(404, 'JOB_NOT_FOUND', 'Job not found');
  }
}

export class QueueUnavailableError extends AppError {
  constructor() {
    super(503, 'QUEUE_UNAVAILABLE', 'Job queue is unavailable');
  }
}
