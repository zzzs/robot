import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export class ResumeDto {
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsIn(['confirm', 'cancel'])
  action: 'confirm' | 'cancel';
}
