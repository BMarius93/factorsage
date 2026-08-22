import type { AuthUser, LoginRequest } from "@intrinsic/contracts";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PasswordService } from "./password.service";
import { UsersService } from "./users.service";

export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

type LoginResult = {
  token: string;
  user: AuthUser;
};

function subjectFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("sub" in payload)) {
    return undefined;
  }

  return typeof payload.sub === "string" ? payload.sub : undefined;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  async login(request: LoginRequest): Promise<LoginResult> {
    const user = await this.users.findForPasswordLogin(request.email);
    const passwordIsValid = await this.passwords.verify(
      user?.passwordHash,
      request.password,
    );

    if (!user || !passwordIsValid) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    return {
      token: await this.jwt.signAsync({ sub: user.id }),
      user: this.users.toAuthUser(user),
    };
  }

  async authenticateToken(token: string): Promise<AuthUser> {
    let payload: unknown;

    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }

    const subject = subjectFromPayload(payload);
    if (!subject) {
      throw new UnauthorizedException();
    }

    const user = await this.users.findAuthUserById(subject);
    if (!user) {
      throw new UnauthorizedException();
    }

    return this.users.toAuthUser(user);
  }
}
