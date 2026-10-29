import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from './users.service';

@Injectable()
export class AuthBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthBootstrapService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const adminEmail = this.configService.get<string>('INITIAL_ADMIN_EMAIL');
    const adminPassword = this.configService.get<string>(
      'INITIAL_ADMIN_PASSWORD',
    );
    const designerEmail = this.configService.get<string>(
      'INITIAL_DESIGNER_EMAIL',
    );
    const designerPassword = this.configService.get<string>(
      'INITIAL_DESIGNER_PASSWORD',
    );

    let adminUserId: string | null = null;

    if (adminEmail && adminPassword) {
      const adminUser = await this.ensureBootstrapUser({
        email: adminEmail,
        password: adminPassword,
        role: 'admin',
        createdByUserId: null,
        forcePasswordReset: false,
        label: 'admin',
      });
      adminUserId = adminUser?.id ?? null;
    }

    if (designerEmail && designerPassword) {
      await this.ensureBootstrapUser({
        email: designerEmail,
        password: designerPassword,
        role: 'staff',
        createdByUserId: adminUserId,
        forcePasswordReset: true,
        label: 'staff',
      });
    }
  }

  private async ensureBootstrapUser(input: {
    email: string;
    password: string;
    role: 'admin' | 'staff';
    createdByUserId: string | null;
    forcePasswordReset: boolean;
    label: string;
  }) {
    const existingUser = await this.usersService.findByEmail(input.email);
    if (existingUser) {
      const reconciledUser = await this.usersService.reconcileBootstrapUser(
        existingUser,
        {
          password: input.password,
          role: input.role,
          createdByUserId: input.createdByUserId,
          forcePasswordReset: input.forcePasswordReset,
        },
      );
      this.logger.log(`Initial ${input.label} ${input.email} already exists.`);
      return reconciledUser;
    }

    const createdUser = await this.usersService.createBootstrapUser({
      email: input.email,
      password: input.password,
      role: input.role,
      createdByUserId: input.createdByUserId,
      forcePasswordReset: input.forcePasswordReset,
    });
    this.logger.log(`Initial ${input.label} ${input.email} was created.`);

    return createdUser;
  }
}
